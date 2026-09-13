/**
 * Borda de saída pós-fusão: envio de mensagem SEMPRE via `sendMessageHandler` do
 * próprio app (app/api/v1/messages/_handler.ts) — o handler insere a linha
 * outbound, envia pelo WAHA, atualiza conversa, audita e emite evento; e dá de
 * graça o guard is_blocked (ApiError 403). A tool `send_message` do agente chama
 * ESTA função depois da cadeia de guardrails; nenhum output de modelo vira
 * mensagem sem passar por aqui.
 *
 * Idempotência (o handler NÃO tem idempotency key própria — o ledger cobre):
 *   1. resposta a inbound usa um `send_ledger.id` UUID determinístico derivado
 *      de (organization_id, inbound_message_id, logical_response_slot); fluxos
 *      sem inbound preservam unique (job_id, seq). O `send_ledger.id` É a
 *      idempotency_key enviada em `metadata.idempotency_key`
 *      da mensagem;
 *   2. chamada ao handler; 'sent' → accepted; 'queued'/'failed' → registrados;
 *   3. retry pós-crash: 'accepted' pula; 'requested' PRIMEIRO procura em
 *      `messages` uma linha com essa idempotency_key (o crash pode ter sido
 *      DEPOIS do envio) — achou, reconcilia o ledger sem reenviar; 'failed'
 *      reabre a mesma chave estável (ou rotaciona a chave legada).
 */
import { createHash } from 'node:crypto';

import { ApiError } from '@/lib/api/types';
import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { Message } from '@/lib/types/messaging';

import type { Queryable } from '../../queue/queue';
import { cancelJob, rescheduleJob, type JobRow } from '../../queue/queue';
import { cancelPendingCronsForLead } from '../../cron/scheduler';
import { CrmTransportError, type CrmEdgeConfig } from './mcp-client';

export type SendLedgerStatus = 'requested' | 'accepted' | 'queued' | 'vetoed' | 'failed';

export interface SendLedgerRow {
  id: string;
  organization_id: string;
  contact_id: string | null;
  job_id: string;
  seq: number;
  body_hash: string;
  status: SendLedgerStatus;
  crm_message_id: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Erro de negócio não classificado do handler (ex.: conversa inexistente) — ledger fica 'requested'. */
export class SendToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendToolError';
  }
}

export type SendOutcome =
  | { kind: 'sent'; idempotencyKey: string; crmMessageId: string }
  /** Ledger já estava 'accepted' — replay pós-crash, nada a enviar. */
  | {
      kind: 'already_sent';
      idempotencyKey: string;
      crmMessageId: string | null;
      duplicateScope: 'job' | 'inbound';
    }
  /** CRM aceitou e SEGURA (sessão ≠ WORKING / waha_not_configured) — job reagendado, nunca dropado. */
  | { kind: 'queued'; idempotencyKey: string; crmMessageId: string | null }
  /** 403 is_blocked — veto PERMANENTE de negócio (opt-out, regra dura nº 2). */
  | { kind: 'blocked'; idempotencyKey: string }
  /** handler registrou a mensagem como 'failed' (sem telefone / erro WAHA). */
  | { kind: 'failed'; idempotencyKey: string; crmMessageId: string | null };

export interface SendMessageInput {
  tenantId: string;
  leadId: string | null;
  jobId: string;
  /** Posição da mensagem no turno (1..n) — com jobId forma a identidade da intenção. */
  seq: number;
  /** Mensagem inbound original; habilita exactly-once entre jobs/eventos/restarts. */
  inboundMessageId?: string;
  /** Slot lógico da resposta. Obrigatório quando inboundMessageId estiver presente. */
  logicalResponseSlot?: string;
  conversationId: string;
  body: string;
  /**
   * Presente = envio de TEMPLATE. O `body` continua sendo o texto RENDERIZADO — é
   * ele que entra no hash de idempotência e é ele que os gates de conteúdo avaliaram.
   * Trocar a chave por "nome do template" faria dois envios com valores diferentes
   * colidirem no ledger e o segundo virar `already_sent` sem ter saído.
   */
  template?: { name: string; language: string; values: Record<string, string> };
}

/** Fallback do ator ai_agent quando não há agente publicado (cfg.agentActorId). */
export const AGENT_ACTOR_ID = 'agent-engine';

/**
 * UUID determinístico aceito pelo Postgres, derivado da identidade lógica da
 * resposta. O bit de versão é marcado como 5 apenas para deixar explícito que
 * não é UUID aleatório; a fonte continua sendo SHA-256 local, sem estado.
 */
export function inboundResponseLedgerId(
  tenantId: string,
  inboundMessageId: string,
  logicalResponseSlot: string,
): string {
  const hex = createHash('sha256')
    .update(`${tenantId}:${inboundMessageId}:${logicalResponseSlot}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/**
 * Envia UMA mensagem do turno pelo handler do app. Intenção exactly-once,
 * entrega at-least-once: throws (transporte) deixam o ledger em 'requested' —
 * o retry reconcilia por `messages.metadata.idempotency_key` antes de reenviar.
 */
export async function sendTurnMessage(
  db: Queryable,
  cfg: CrmEdgeConfig,
  input: SendMessageInput,
  deps: { handler?: typeof sendMessageHandler } = {},
): Promise<SendOutcome> {
  const bodyHash = createHash('sha256').update(input.body).digest('hex');
  const ledger = await claimLedgerRow(db, input, bodyHash);
  if (ledger.shortCircuit) {
    return ledger.shortCircuit;
  }
  const idempotencyKey = ledger.key;

  // Replay de 'requested': o crash pode ter sido DEPOIS do handler gravar a
  // mensagem — procurar pela key evita duplicar o envio.
  if (ledger.replay) {
    const { rows } = await db.query<{ id: string; status: string }>(
      `select id, status from messages
       where organization_id = $1 and metadata->>'idempotency_key' = $2
       limit 1`,
      [input.tenantId, idempotencyKey],
    );
    const existing = rows[0];
    if (existing) {
      return reconcile(
        db,
        idempotencyKey,
        existing.id,
        existing.status,
        ledger.ownedByDifferentJob ? 'inbound' : 'job',
      );
    }
    // Reserva criada por OUTRO job para o mesmo inbound/slot. Mesmo sem linha em
    // messages ainda, este job não toma a intenção para si: o job proprietário é
    // quem será retomado pelo reaper. Isso fecha a corrida entre dois event_log
    // ids sem depender de cache do processo.
    if (ledger.ownedByDifferentJob) {
      return {
        kind: 'already_sent',
        idempotencyKey,
        crmMessageId: null,
        duplicateScope: 'inbound',
      };
    }
  }

  let message: Message;
  try {
    message = await (deps.handler ?? sendMessageHandler)(
      cfg.supabase,
      {
        organization_id: input.tenantId,
        actor: { type: 'ai_agent', id: cfg.agentActorId ?? AGENT_ACTOR_ID, role: 'manager' },
        requestId: idempotencyKey,
      },
      {
        conversation_id: input.conversationId,
        ...(input.template
          ? {
              type: 'template' as const,
              template_name: input.template.name,
              template_language: input.template.language,
              template_values: input.template.values,
            }
          : { type: 'text' as const }),
        body: input.body,
        metadata: { idempotency_key: idempotencyKey },
      },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      await updateLedger(db, idempotencyKey, 'vetoed', null, 'handler 403: contato bloqueado (is_blocked)');
      return { kind: 'blocked', idempotencyKey };
    }
    if (err instanceof ApiError && err.status === 404) {
      await touchLedgerError(db, idempotencyKey, 'conversa não encontrada');
      throw new SendToolError('envio recusado: conversa não encontrada');
    }
    // Qualquer outra falha (Supabase fora, erro interno do handler): transiente —
    // o ledger fica 'requested' e o replay reconcilia pela key.
    const msg = err instanceof Error ? err.message : String(err);
    await touchLedgerError(db, idempotencyKey, msg);
    throw new CrmTransportError(`handler de envio indisponível: ${msg.slice(0, 120)}`);
  }

  return reconcile(db, idempotencyKey, message.id, message.status);
}

/** Mapeia o status da linha `messages` para o outcome + atualiza o ledger. */
async function reconcile(
  db: Queryable,
  idempotencyKey: string,
  messageId: string,
  status: string,
  replayScope?: 'job' | 'inbound',
): Promise<SendOutcome> {
  switch (status) {
    case 'sent':
      await updateLedger(db, idempotencyKey, 'accepted', messageId, null);
      if (replayScope !== undefined) {
        return {
          kind: 'already_sent',
          idempotencyKey,
          crmMessageId: messageId,
          duplicateScope: replayScope,
        };
      }
      return { kind: 'sent', idempotencyKey, crmMessageId: messageId };
    case 'queued':
      await updateLedger(db, idempotencyKey, 'queued', messageId, null);
      return { kind: 'queued', idempotencyKey, crmMessageId: messageId };
    case 'failed':
      await updateLedger(db, idempotencyKey, 'failed', messageId, 'handler marcou a mensagem como failed');
      return { kind: 'failed', idempotencyKey, crmMessageId: messageId };
    default:
      // status desconhecido (ex.: delivered em replay tardio = já saiu) — trate
      // como aceito: a mensagem existe sob custódia do CRM.
      await updateLedger(db, idempotencyKey, 'accepted', messageId, null);
      if (replayScope !== undefined) {
        return {
          kind: 'already_sent',
          idempotencyKey,
          crmMessageId: messageId,
          duplicateScope: replayScope,
        };
      }
      return { kind: 'sent', idempotencyKey, crmMessageId: messageId };
  }
}

/**
 * Passo 1 do fluxo: garante a linha pela identidade estável do inbound (ou por
 * job_id/seq nos fluxos legados) e decide o caminho.
 * Linha nova → envio normal. 'requested' → replay (reconciliar antes de reenviar).
 * 'accepted'/'queued'/'vetoed' → short-circuit. 'failed' → rotaciona o id.
 */
async function claimLedgerRow(
  db: Queryable,
  input: SendMessageInput,
  bodyHash: string,
): Promise<{
  key: string;
  replay?: boolean;
  ownedByDifferentJob?: boolean;
  shortCircuit?: SendOutcome;
}> {
  const stableId = stableResponseId(input);
  try {
    const { rows } = stableId
      ? await db.query<{ id: string }>(
          `insert into send_ledger (id, organization_id, contact_id, job_id, seq, body_hash)
           values ($1, $2, $3, $4, $5, $6)
           returning id`,
          [stableId, input.tenantId, input.leadId, input.jobId, input.seq, bodyHash],
        )
      : await db.query<{ id: string }>(
          `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash)
           values ($1, $2, $3, $4, $5)
           returning id`,
          [input.tenantId, input.leadId, input.jobId, input.seq, bodyHash],
        );
    const id = rows[0]?.id;
    if (!id) throw new Error('insert em send_ledger não devolveu linha');
    return { key: id };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  const { rows } = stableId
    ? await db.query<SendLedgerRow>(
        'select * from send_ledger where id = $1 and organization_id = $2',
        [stableId, input.tenantId],
      )
    : await db.query<SendLedgerRow>(
        'select * from send_ledger where job_id = $1 and seq = $2',
        [input.jobId, input.seq],
      );
  const existing = rows[0];
  if (!existing) throw new Error('linha do send_ledger sumiu entre o 23505 e o select');
  const duplicateScope = existing.job_id === input.jobId ? 'job' : 'inbound';

  switch (existing.status) {
    case 'accepted':
      return {
        key: existing.id,
        shortCircuit: {
          kind: 'already_sent',
          idempotencyKey: existing.id,
          crmMessageId: existing.crm_message_id,
          duplicateScope,
        },
      };
    case 'queued':
      // A mensagem JÁ está sob custódia do CRM (linha 'queued' em messages) —
      // reenviar duplicaria; reconciliar o estado real é leitura no turno.
      return {
        key: existing.id,
        shortCircuit: { kind: 'queued', idempotencyKey: existing.id, crmMessageId: existing.crm_message_id },
      };
    case 'vetoed':
      return { key: existing.id, shortCircuit: { kind: 'blocked', idempotencyKey: existing.id } };
    case 'failed': {
      // No caminho estável o id NÃO pode rotacionar: ele é a barreira entre
      // jobs. Reabre a mesma reserva; mensagens failed não contam como entrega.
      const rotated = stableId
        ? await db.query<{ id: string }>(
            `update send_ledger
             set status = 'requested', body_hash = $2,
                 crm_message_id = null, last_error = null, updated_at = now()
             where id = $1
             returning id`,
            [stableId, bodyHash],
          )
        : await db.query<{ id: string }>(
            `update send_ledger
             set id = gen_random_uuid(), status = 'requested', body_hash = $3,
                 crm_message_id = null, last_error = null, updated_at = now()
             where job_id = $1 and seq = $2
             returning id`,
            [input.jobId, input.seq, bodyHash],
          );
      const id = rotated.rows[0]?.id;
      if (!id) throw new Error('rotação de key no send_ledger não devolveu linha');
      return { key: id };
    }
    default: // 'requested': crash entre insert e resposta — reconciliar pela key
      return {
        key: existing.id,
        replay: true,
        ownedByDifferentJob: duplicateScope === 'inbound',
      };
  }
}

function stableResponseId(input: SendMessageInput): string | null {
  if (input.inboundMessageId === undefined && input.logicalResponseSlot === undefined) return null;
  if (!input.inboundMessageId || !input.logicalResponseSlot) {
    throw new Error('inboundMessageId e logicalResponseSlot devem ser informados juntos');
  }
  return inboundResponseLedgerId(input.tenantId, input.inboundMessageId, input.logicalResponseSlot);
}

async function updateLedger(
  db: Queryable,
  id: string,
  status: SendLedgerStatus,
  crmMessageId: string | null,
  lastError: string | null,
): Promise<void> {
  await db.query(
    `update send_ledger
     set status = $2, crm_message_id = coalesce($3, crm_message_id),
         last_error = $4, updated_at = now()
     where id = $1`,
    [id, status, crmMessageId, lastError],
  );
}

async function touchLedgerError(db: Queryable, id: string, errorText: string): Promise<void> {
  await db.query(
    `update send_ledger set last_error = $2, updated_at = now() where id = $1`,
    [id, errorText.slice(0, 300)],
  );
}

export type SendDisposition =
  /** Job cancelado em definitivo (veto is_blocked) — não re-tenta. */
  | { action: 'canceled'; job: JobRow | null }
  /** Job devolvido a 'pending' com run_after adiado, sem consumir attempts. */
  | { action: 'requeued'; job: JobRow | null }
  /** Nada a fazer com o job aqui: 'sent'/'already_sent' seguem para complete; 'failed' segue para failJob. */
  | { action: 'none' };

/**
 * Disposição do JOB conforme o outcome do envio:
 * - blocked → cancela o job (terminal — opt-out não é incidente) e cancela TODOS
 *   os follow-ups agendados do contato (irrevogável, regra dura nº 2). A fonte
 *   do bloqueio JÁ é contacts.is_blocked — não existe mais cache a atualizar;
 * - queued → reagenda com `delayMs` (knob SEND_QUEUED_RETRY_MS) SEM consumir
 *   attempts — sessão fora não pode matar mensagem de lead saudável;
 * - demais → responsabilidade do worker (complete/failJob pelos caminhos normais).
 */
export async function applySendOutcome(
  db: Queryable,
  outcome: SendOutcome,
  job: { jobId: string; workerId: string; tenantId: string; leadId: string | null },
  knobs: { queuedRetryDelayMs: number },
): Promise<SendDisposition> {
  switch (outcome.kind) {
    case 'blocked': {
      const canceled = await cancelJob(
        db,
        job.jobId,
        job.workerId,
        'envio vetado pelo sink: contato bloqueado (is_blocked) — opt-out irrevogável',
      );
      if (job.leadId) {
        await cancelPendingCronsForLead(db, job.tenantId, job.leadId);
      }
      return { action: 'canceled', job: canceled };
    }
    case 'queued': {
      const requeued = await rescheduleJob(db, job.jobId, job.workerId, {
        delayMs: knobs.queuedRetryDelayMs,
        reason: 'sessão do canal fora (resposta queued) — reagendado sem consumir attempts',
      });
      return { action: 'requeued', job: requeued };
    }
    default:
      return { action: 'none' };
  }
}

// Mesmo predicado de queue.ts (não exportado lá de propósito — módulos sem deps cruzadas).
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

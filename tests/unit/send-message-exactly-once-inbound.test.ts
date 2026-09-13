import { beforeEach, describe, expect, it } from 'vitest';

import {
  inboundResponseLedgerId,
  sendTurnMessage,
} from '@/lib/agent-engine/edge/crm/send-message';

type Handler = (...args: unknown[]) => Promise<unknown>;
let handlerImpl: Handler;

interface Ledger {
  id: string;
  organization_id: string;
  contact_id: string | null;
  job_id: string;
  seq: number;
  body_hash: string;
  status: 'requested' | 'accepted' | 'queued' | 'vetoed' | 'failed';
  crm_message_id: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface StoredMessage {
  id: string;
  status: string;
  idempotencyKey: string;
}

class DurableDb {
  readonly ledgers: Map<string, Ledger>;
  readonly messages: StoredMessage[];

  constructor(snapshot?: { ledgers: Ledger[]; messages: StoredMessage[] }) {
    this.ledgers = new Map((snapshot?.ledgers ?? []).map((row) => [row.id, { ...row }]));
    this.messages = (snapshot?.messages ?? []).map((row) => ({ ...row }));
  }

  snapshot() {
    return {
      ledgers: [...this.ledgers.values()].map((row) => ({ ...row })),
      messages: this.messages.map((row) => ({ ...row })),
    };
  }

  async query(text: string, values: unknown[] = []) {
    const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (sql.startsWith('insert into send_ledger')) {
      const stable = sql.includes('(id, organization_id');
      const id = stable ? String(values[0]) : `legacy-${this.ledgers.size + 1}`;
      const tenant = String(values[stable ? 1 : 0]);
      const lead = values[stable ? 2 : 1] as string | null;
      const job = String(values[stable ? 3 : 2]);
      const seq = Number(values[stable ? 4 : 3]);
      const bodyHash = String(values[stable ? 5 : 4]);
      const duplicate =
        this.ledgers.has(id) ||
        [...this.ledgers.values()].some((row) => row.job_id === job && row.seq === seq);
      if (duplicate) throw Object.assign(new Error('duplicate'), { code: '23505' });
      const now = new Date();
      const row: Ledger = {
        id,
        organization_id: tenant,
        contact_id: lead,
        job_id: job,
        seq,
        body_hash: bodyHash,
        status: 'requested',
        crm_message_id: null,
        last_error: null,
        created_at: now,
        updated_at: now,
      };
      this.ledgers.set(id, row);
      return result([{ id }]);
    }
    if (sql.startsWith('select * from send_ledger where id =')) {
      const row = this.ledgers.get(String(values[0]));
      return result(row ? [row] : []);
    }
    if (sql.startsWith('select * from send_ledger where job_id =')) {
      const row = [...this.ledgers.values()].find(
        (candidate) => candidate.job_id === values[0] && candidate.seq === values[1],
      );
      return result(row ? [row] : []);
    }
    if (sql.startsWith('select id, status from messages')) {
      const row = this.messages.find((candidate) => candidate.idempotencyKey === values[1]);
      return result(row ? [{ id: row.id, status: row.status }] : []);
    }
    if (sql.startsWith('update send_ledger set status = $2')) {
      const row = this.mustLedger(String(values[0]));
      row.status = values[1] as Ledger['status'];
      row.crm_message_id = (values[2] as string | null) ?? row.crm_message_id;
      row.last_error = values[3] as string | null;
      row.updated_at = new Date();
      return result([]);
    }
    if (sql.startsWith('update send_ledger set last_error = $2')) {
      const row = this.mustLedger(String(values[0]));
      row.last_error = String(values[1]);
      row.updated_at = new Date();
      return result([]);
    }
    if (sql.startsWith("update send_ledger set status = 'requested'")) {
      const row = this.mustLedger(String(values[0]));
      row.status = 'requested';
      row.body_hash = String(values[1]);
      row.crm_message_id = null;
      row.last_error = null;
      return result([{ id: row.id }]);
    }
    throw new Error(`SQL não coberto pelo fake: ${sql}`);
  }

  private mustLedger(id: string): Ledger {
    const row = this.ledgers.get(id);
    if (!row) throw new Error(`ledger ausente: ${id}`);
    return row;
  }
}

function result<T>(rows: T[]) {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
}

const ORG = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const INBOUND_1 = '33333333-3333-4333-8333-333333333333';
const INBOUND_2 = '44444444-4444-4444-8444-444444444444';

function input(jobId: string, inboundMessageId = INBOUND_1, logicalResponseSlot = 'assistant_primary') {
  return {
    tenantId: ORG,
    leadId: CONTACT,
    jobId,
    seq: logicalResponseSlot === 'assistant_primary' ? 1 : 2,
    inboundMessageId,
    logicalResponseSlot,
    conversationId: '55555555-5555-4555-8555-555555555555',
    body: 'Resposta comercial',
  };
}

function installSuccessfulHandler(db: DurableDb, outboundCounter: { value: number }) {
  handlerImpl = async (...args: unknown[]) => {
    const payload = args[2] as { metadata: { idempotency_key: string } };
    if (payload === undefined) throw new Error(`handler recebeu ${args.length} argumentos`);
    outboundCounter.value += 1;
    const id = `message-${outboundCounter.value}`;
    db.messages.push({
      id,
      status: 'sent',
      idempotencyKey: payload.metadata.idempotency_key,
    });
    return { id, status: 'sent' };
  };
}

async function send(db: DurableDb, value: ReturnType<typeof input>) {
  return sendTurnMessage(db as never, { supabase: {} } as never, value, {
    handler: ((...args: unknown[]) => handlerImpl(...args)) as never,
  });
}

beforeEach(() => {
  handlerImpl = async () => {
    throw new Error('handler de teste não configurado');
  };
});

describe('sendTurnMessage — exactly-once por inbound', () => {
  it('mesmo job + retry produz 1 outbound', async () => {
    const db = new DurableDb();
    const count = { value: 0 };
    installSuccessfulHandler(db, count);
    await send(db, input('job-a'));
    const replay = await send(db, input('job-a'));
    expect(count.value).toBe(1);
    expect(replay).toMatchObject({ kind: 'already_sent', duplicateScope: 'job' });
  });

  it('dois jobs diferentes + mesmo inbound_message_id produzem 1 outbound', async () => {
    const db = new DurableDb();
    const count = { value: 0 };
    installSuccessfulHandler(db, count);
    await send(db, input('job-event-a'));
    const replay = await send(db, input('job-event-b'));
    expect(count.value).toBe(1);
    expect(replay).toMatchObject({ kind: 'already_sent', duplicateScope: 'inbound' });
  });

  it('dois jobs concorrentes + mesmo inbound reservam um único outbound', async () => {
    const db = new DurableDb();
    const count = { value: 0 };
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    handlerImpl = async (...args: unknown[]) => {
      const payload = args[2] as { metadata: { idempotency_key: string } };
      count.value += 1;
      markEntered();
      await release;
      db.messages.push({
        id: 'message-concurrent',
        status: 'sent',
        idempotencyKey: payload.metadata.idempotency_key,
      });
      return { id: 'message-concurrent', status: 'sent' };
    };

    const first = send(db, input('job-concurrent-a'));
    await entered;
    const second = await send(db, input('job-concurrent-b'));
    expect(second).toMatchObject({ kind: 'already_sent', duplicateScope: 'inbound' });
    releaseFirst();
    await first;
    expect(count.value).toBe(1);
  });

  it('dois event_log ids diferentes + mesmo inbound_message_id produzem 1 outbound', async () => {
    const db = new DurableDb();
    const count = { value: 0 };
    installSuccessfulHandler(db, count);
    await send(db, input('job-from-event-log-1'));
    await send(db, input('job-from-event-log-2'));
    expect(count.value).toBe(1);
  });

  it('crash após messages row criada é reconciliado sem reenvio', async () => {
    const db = new DurableDb();
    const count = { value: 0 };
    handlerImpl = async (...args: unknown[]) => {
      const payload = args[2] as { metadata: { idempotency_key: string } };
      if (payload === undefined) throw new Error(`handler recebeu ${args.length} argumentos`);
      count.value += 1;
      db.messages.push({
        id: 'message-before-crash',
        status: 'sent',
        idempotencyKey: payload.metadata.idempotency_key,
      });
      throw new Error('crash after messages insert');
    };
    await expect(send(db, input('job-crash'))).rejects.toThrow();
    installSuccessfulHandler(db, count);
    const replay = await send(db, input('job-crash'));
    expect(count.value).toBe(1);
    expect(replay).toMatchObject({ kind: 'already_sent', crmMessageId: 'message-before-crash' });
  });

  it('restart simulado preserva a deduplicação durável', async () => {
    let db = new DurableDb();
    const count = { value: 0 };
    installSuccessfulHandler(db, count);
    await send(db, input('job-before-restart'));
    db = new DurableDb(db.snapshot());
    installSuccessfulHandler(db, count);
    await send(db, input('job-after-restart'));
    expect(count.value).toBe(1);
  });

  it('inbound novo pode responder normalmente', async () => {
    const db = new DurableDb();
    const count = { value: 0 };
    installSuccessfulHandler(db, count);
    await send(db, input('job-a', INBOUND_1));
    await send(db, input('job-b', INBOUND_2));
    expect(count.value).toBe(2);
  });

  it('duas mensagens diferentes do mesmo contato recebem respostas próprias', async () => {
    const db = new DurableDb();
    const count = { value: 0 };
    installSuccessfulHandler(db, count);
    await send(db, input('job-contact-1', INBOUND_1));
    await send(db, input('job-contact-2', INBOUND_2));
    expect(count.value).toBe(2);
  });

  it('multi-bubble explícito permite slots diferentes', async () => {
    const db = new DurableDb();
    const count = { value: 0 };
    installSuccessfulHandler(db, count);
    await send(db, input('job-bubbles', INBOUND_1, 'assistant_primary'));
    await send(db, input('job-bubbles', INBOUND_1, 'assistant_primary:2'));
    expect(count.value).toBe(2);
  });

  it('cinco replays do mesmo inbound mantêm outbound total em 1', async () => {
    const db = new DurableDb();
    const count = { value: 0 };
    installSuccessfulHandler(db, count);
    for (let index = 0; index < 5; index += 1) {
      await send(db, input(`job-replay-${index}`));
    }
    expect(count.value).toBe(1);
  });

  it('chave é estável por inbound/slot e muda entre slots', () => {
    const primary = inboundResponseLedgerId(ORG, INBOUND_1, 'assistant_primary');
    expect(inboundResponseLedgerId(ORG, INBOUND_1, 'assistant_primary')).toBe(primary);
    expect(inboundResponseLedgerId(ORG, INBOUND_1, 'assistant_primary:2')).not.toBe(primary);
    expect(primary).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

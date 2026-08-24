/**
 * Executor de contingência para o turno inbound.
 *
 * O agent-worker 24/7 continua sendo o consumidor preferencial da fila. Este
 * módulo roda UMA vez a partir do webhook quando o CRM está em ambiente
 * serverless: drena o evento que acabou de entrar e executa no máximo um turno
 * inbound. Assim uma resposta do lead não fica sem continuidade caso o daemon
 * externo esteja indisponível.
 */
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import type pg from "pg";

import { createInboundTurnHandler, type InboundTurnDeps } from "@/lib/agent-engine/agent/inbound-turn";
import { createPool } from "@/lib/agent-engine/db/pool";
import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { crmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/crm/mcp-client";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/run-model-call";
import { loadEnv, type Env } from "@/lib/agent-engine/env";
import { createLogger, type Logger } from "@/lib/agent-engine/obs/logger";
import { completeJob, failJob, type JobRow } from "@/lib/agent-engine/queue/queue";

const FALLBACK_WORKER_ID = `agent-inbound-fallback-${hostname()}-${process.pid}`;

function messageFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n", 1)[0] ?? "").slice(0, 300);
}

function inboundTurnDeps(env: Env, log: Logger): InboundTurnDeps {
  return {
    crmCfg: crmEdgeConfigFromEnv({
      SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    }),
    llmCfg: llmEdgeConfigFromEnv(env),
    knobs: {
      historyLimit: env.LEAD_CONTEXT_HISTORY_LIMIT,
      maxContextTokens: env.LEAD_CONTEXT_MAX_TOKENS,
      notesIndexMaxTokens: env.LEAD_NOTES_INDEX_MAX_TOKENS,
      maxSteps: env.AGENT_MAX_STEPS,
      queuedRetryDelayMs: env.SEND_QUEUED_RETRY_MS,
      breaker: {
        exactFailureWarn: env.TOOL_BREAKER_EXACT_WARN,
        exactFailureBlock: env.TOOL_BREAKER_EXACT_BLOCK,
        sameToolFailureWarn: env.TOOL_BREAKER_SAME_TOOL_WARN,
        sameToolFailureHalt: env.TOOL_BREAKER_SAME_TOOL_HALT,
        noProgressWarn: env.TOOL_BREAKER_NO_PROGRESS_WARN,
        noProgressBlock: env.TOOL_BREAKER_NO_PROGRESS_BLOCK,
      },
      followup: {
        minAheadMs: env.FOLLOWUP_MIN_AHEAD_MS,
        maxAheadMs: env.FOLLOWUP_MAX_AHEAD_MS,
        staggerWindowMs: env.CRON_STAGGER_WINDOW_MS,
      },
      compaction: {
        triggerMessages: env.COMPACTION_TRIGGER_MESSAGES,
        ...(env.COMPACTION_MODEL !== undefined ? { model: env.COMPACTION_MODEL } : {}),
        transcriptMaxTokens: env.COMPACTION_TRANSCRIPT_MAX_TOKENS,
      },
      prune: {
        windowTurns: env.PRUNE_TOOL_RESULTS_WINDOW_TURNS,
        minResultTokens: env.PRUNE_TOOL_RESULTS_MIN_RESULT_TOKENS,
      },
      goldenCandidatesDir: env.GOLDEN_CANDIDATES_DIR,
      stageClassifier: {
        ...(env.STAGE_CLASSIFIER_MODEL !== undefined ? { model: env.STAGE_CLASSIFIER_MODEL } : {}),
      },
      jailbreak: {
        ...(env.JAILBREAK_CLASSIFIER_MODEL !== undefined ? { model: env.JAILBREAK_CLASSIFIER_MODEL } : {}),
      },
      disclosureMode: env.DISCLOSURE_MODE,
      promiseSemantic: {
        enabled: env.PROMISE_SEMANTIC_ENABLED,
        ...(env.PROMISE_SEMANTIC_MODEL !== undefined ? { model: env.PROMISE_SEMANTIC_MODEL } : {}),
      },
      followupAi: {
        ...(env.FOLLOWUP_AI_MODEL !== undefined ? { model: env.FOLLOWUP_AI_MODEL } : {}),
      },
    },
    log,
  };
}

/** Claima somente inbound_turn, sem tomar follow-ups ou rotinas de sistema. */
async function claimInboundJob(pool: pg.Pool, workerId: string): Promise<JobRow | null> {
  const { rows } = await pool.query<JobRow>(
    `with candidate as (
       select j.id
       from job_queue j
       where j.kind = 'inbound_turn'
         and j.status = 'pending'
         and j.run_after <= now()
         and (j.contact_id is null or not exists (
           select 1 from job_queue running
           where running.contact_id = j.contact_id and running.status = 'running'
         ))
       order by j.priority, j.run_after
       limit 1
       for update skip locked
     )
     update job_queue
     set status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
     where id in (select id from candidate)
     returning *`,
    [workerId],
  );
  return rows[0] ?? null;
}

export type InboundFallbackResult =
  | { outcome: "idle"; drained: number }
  | { outcome: "completed"; drained: number; jobId: string }
  | { outcome: "failed"; drained: number; jobId: string };

/**
 * Drena a entrada pendente e executa no máximo um turno. A espera respeita a
 * janela de coalescência já configurada para não responder em rajada.
 */
export async function runInboundTurnFallback(): Promise<InboundFallbackResult> {
  const env = loadEnv();
  const log = createLogger();
  const pool = createPool(env.SUPABASE_DB_URL, (error) =>
    log.error("agent fallback: pool indisponível", { error: messageFromError(error) }),
  );

  try {
    const knobs = {
      batchSize: env.CRM_DRAIN_BATCH_SIZE,
      intervalMs: env.CRM_DRAIN_INTERVAL_MS,
      idleIntervalMs: env.CRM_DRAIN_IDLE_INTERVAL_MS,
      debounceMs: env.INBOUND_DEBOUNCE_MS,
      reapTimeoutMs: env.CRM_EVENT_REAP_TIMEOUT_MS,
    };
    const drained = await drainTick(pool, knobs, log);

    let job = await claimInboundJob(pool, FALLBACK_WORKER_ID);
    if (!job && env.INBOUND_DEBOUNCE_MS > 0) {
      await sleep(env.INBOUND_DEBOUNCE_MS);
      job = await claimInboundJob(pool, FALLBACK_WORKER_ID);
    }
    if (!job) return { outcome: "idle", drained };

    try {
      await createInboundTurnHandler(inboundTurnDeps(env, log))(job, pool, {
        workerId: FALLBACK_WORKER_ID,
      });
      await completeJob(pool, job.id, FALLBACK_WORKER_ID);
      log.info("agent fallback: turno inbound concluído", { job_id: job.id });
      return { outcome: "completed", drained, jobId: job.id };
    } catch (error) {
      await failJob(pool, job.id, FALLBACK_WORKER_ID, error);
      log.error("agent fallback: turno inbound falhou", {
        job_id: job.id,
        error: messageFromError(error),
      });
      return { outcome: "failed", drained, jobId: job.id };
    }
  } finally {
    await pool.end();
  }
}

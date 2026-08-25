/**
 * Vercel project config (canonical TS form).
 *
 * Crons placeholder; lista final virá da Spec 08 (Operações & Workers).
 * Os 7 crons abaixo refletem os jobs derivados das specs herdadas:
 *  - recover-stuck-messages (WAHA)
 *  - sync-sessions (WAHA)
 *  - process-pending-webhooks (event_log)
 *  - dispatch-webhooks (deliveries / outbound webhooks)
 *  - lgpd-data-request-worker (D+7 SLA)
 *  - nuvemshop-sync-incremental
 *  - audit-log-archive (cold storage)
 *
 * Auth de cron: header `Authorization: Bearer ${INTERNAL_SECRET}` validado em cada handler.
 */

import type { VercelConfig } from "@vercel/config/v1";

const config: VercelConfig = {
  // A operação temporária usa o Vercel como scheduler: a execução diária
  // reabre a fila de prospecção e processa os follow-ups D+2 sem depender de
  // um daemon local com secrets de produção. 12:00 UTC = 09:00 em Brasília.
  // O claim no banco mantém a rota idempotente caso uma reconexão do WhatsApp
  // também dispare a campanha no mesmo dia.
  crons: [
    { path: "/api/v1/cron/prospecting-dispatch", schedule: "0 12 * * *" },
  ],
  functions: {
    // EPIC-13 S-13.08: ToolLoopAgent runtime can issue multiple tool calls per
    // step. 300s max keeps Fluid Compute within bounds; the runtime's own
    // step/token/cost guards usually finish much earlier.
    "app/api/internal/agents/run/route.ts": { maxDuration: 300 },
  },
};

export default config;

/**
 * Helper DRY para rotas de controle da GB Command Center.
 *
 * Cada rota (pause-prospecting, resume-outbound, emergency-stop, ...)
 * chama `runControl({ db, orgId, requestId, body, set })` que:
 *   1. atualiza command_center_state conforme `set`
 *   2. emite evento no event_log para auditoria
 *   3. devolve snapshot
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";

export interface ControlPatch {
  prospecting_paused?: boolean;
  outbound_paused?: boolean;
  emergency_stop?: boolean;
  paused_reason?: string | null;
}

export async function runControl(opts: {
  db: SupabaseClient;
  organizationId: string;
  requestId: string;
  action: "pause-prospecting" | "resume-prospecting" | "pause-outbound" | "resume-outbound" | "emergency-stop" | "resume-all";
  userId: string | null;
  body: unknown;
}): Promise<Response> {
  const set: ControlPatch = {};
  let eventType = "";
  let reasonDefault: string | null = null;
  switch (opts.action) {
    case "pause-prospecting":
      set.prospecting_paused = true;
      eventType = "command_center_pause_prospecting";
      reasonDefault = "pausado via Command Center";
      break;
    case "resume-prospecting":
      set.prospecting_paused = false;
      set.paused_reason = null;
      eventType = "command_center_resume_prospecting";
      break;
    case "pause-outbound":
      set.outbound_paused = true;
      eventType = "command_center_pause_outbound";
      reasonDefault = "outbound pausado via Command Center";
      break;
    case "resume-outbound":
      set.outbound_paused = false;
      set.paused_reason = null;
      eventType = "command_center_resume_outbound";
      break;
    case "emergency-stop":
      set.prospecting_paused = true;
      set.outbound_paused = true;
      set.emergency_stop = true;
      eventType = "command_center_emergency_stop";
      reasonDefault = "EMERGENCY STOP via Command Center";
      break;
    case "resume-all":
      set.prospecting_paused = false;
      set.outbound_paused = false;
      set.emergency_stop = false;
      set.paused_reason = null;
      eventType = "command_center_resume_all";
      break;
  }
  if (typeof opts.body === "object" && opts.body !== null) {
    const b = opts.body as { reason?: unknown };
    if (typeof b.reason === "string" && b.reason.trim()) {
      set.paused_reason = b.reason.trim();
    } else if (reasonDefault && set.paused_reason === undefined) {
      set.paused_reason = reasonDefault;
    }
  } else if (reasonDefault && set.paused_reason === undefined) {
    set.paused_reason = reasonDefault;
  }
  set.paused_reason = set.paused_reason ?? null;

  const { error: upErr } = await opts.db
    .from("command_center_state")
    .update({ ...set, updated_at: new Date().toISOString() })
    .eq("organization_id", opts.organizationId);
  if (upErr) {
    return fail("control_update_failed", upErr.message, 500, { requestId: opts.requestId });
  }

  const payload = {
    action: opts.action,
    set,
    by: opts.userId,
  };
  await opts.db.rpc("emit_event" as never, {
    p_event_type: eventType,
    p_entity_kind: "command_center_state",
    p_entity_id: opts.organizationId,
    p_payload: payload,
    p_metadata: { severity: "info", request_id: opts.requestId },
    p_organization_id: opts.organizationId,
  } as never);

  logger.info(`command-center: ${opts.action}`, { request_id: opts.requestId, organization_id: opts.organizationId });
  return ok({ action: opts.action, set, applied: true }, { requestId: opts.requestId });
}

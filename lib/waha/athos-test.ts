import { createHash } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { WahaEnvelope } from "@/lib/waha/ingest";
import { sendWAHA } from "@/lib/waha/send";
import { parseWahaMessageId } from "@/lib/waha/message-id";

export const ATHOS_TEST_ORG = "036bb1d5-2cb6-4346-9c19-3dbb1c0d0433";
export const ATHOS_TEST_SESSION = "15ed07d7-57f9-4746-a543-d8768003848b";
type Admin = ReturnType<typeof createAdminClient>;
export interface AthosTestSession {
  id: string;
  organization_id: string;
  waha_session_name: string;
}
export function isAthosTestSession(session: AthosTestSession): boolean {
  return process.env.ATHOS_TEST_MODE === "true" &&
    session.organization_id === ATHOS_TEST_ORG && session.id === ATHOS_TEST_SESSION;
}

export function athosTrace(correlationId: string, startedAt: number) {
  let lastAt = startedAt;
  return (stage: string, details: Record<string, unknown> = {}) => {
    const now = Date.now();
    console.log(JSON.stringify({
      scope: "ATHOS-TEST", stage, correlation_id: correlationId,
      timestamp: new Date(now).toISOString(), elapsed_ms: now - startedAt,
      duration_ms: now - lastAt, ...details,
    }));
    lastAt = now;
  };
}

/** Single-process homologation only. Concurrent copies share the same outcome.
 * Ambiguous outbound failures remain failed until operator reconciliation.
 * This temporary mode is not a production send ledger and cannot use replicas.
 */
export function createAthosTestHandler(deps = { send: sendWAHA }) {
  const attempts = new Map<string, Promise<boolean>>();
  return async (admin: Admin, session: AthosTestSession, envelope: WahaEnvelope,
    startedAt = Date.now(), requestId?: string): Promise<boolean> => {
    if (!isAthosTestSession(session)) return false;
    const p = envelope.payload;
    if (!p || p.fromMe || !["message", "message.any"].includes(envelope.event ?? "")) return false;
    if (envelope.session !== session.waha_session_name) throw new Error("athos_session_mismatch");
    if (!p.id || !p.from || !/^[0-9]+@(c\.us|s\.whatsapp\.net|lid)$/.test(p.from)) return false;
    if (!p.body && !p.hasMedia && !p.mediaUrl && !p.media?.url) return false;
    const chatId = p.from;

    const key = createHash("sha256").update(`${session.organization_id}:${session.id}:${p.from}:${p.id}`).digest("hex");
    const trace = athosTrace(requestId ?? key, startedAt);
    const previous = attempts.get(key);
    if (previous) {
      trace("duplicate_received", { message_key: key });
      return previous;
    }
    // Never evict completed/ambiguous sends and silently allow duplicate retries.
    if (attempts.size >= 10000) throw new Error("athos_test_capacity_reached");
    const task = (async () => {
      let outboundStarted = false;
      let stage = "tenant_lookup_finished";
      try {
        trace("tenant_resolved", { organization_id: session.organization_id, session_id: session.id, message_key: key });
        stage = "menu_lookup_started";
        trace(stage);
        const { data, error } = await admin.from("food_commerce_settings")
          .select("app_name, settings")
          .eq("organization_id", session.organization_id).eq("is_enabled", true)
          .order("updated_at", { ascending: false }).limit(1)
          .abortSignal(AbortSignal.timeout(8000)).maybeSingle();
        if (error) throw new Error(`athos_menu_lookup_failed: ${error.code ?? ""} ${error.message}`);
        const settings = data?.settings as Record<string, unknown> | undefined;
        const menuUrl = settings?.athos_menu_url;
        if (settings?.environment !== "sandbox") throw new Error("athos_test_requires_sandbox");
        if (typeof menuUrl !== "string" || new URL(menuUrl).protocol !== "https:") {
          throw new Error("athos_menu_url_missing_or_invalid");
        }
        trace("menu_lookup_finished");
        trace("menu_url_loaded", { menu_url: menuUrl, tenant: data?.app_name });
        stage = "outbound_started";
        trace(stage);
        outboundStarted = true;
        const result = await deps.send({ sessionName: session.waha_session_name,
          chatId, text: `Olá! 😊 Aqui está nosso cardápio:\n${menuUrl}`,
          timeoutMs: 10000 });
        const outboundId = parseWahaMessageId(result);
        if (!outboundId) throw new Error("athos_outbound_acceptance_unconfirmed");
        trace("outbound_success", { outbound_id: outboundId, delivery: "provider_accepted" });
        trace("processing_finished", { outcome: "accepted", total_ms: Date.now() - startedAt });
        return true;
      } catch (error) {
        if (!outboundStarted) attempts.delete(key);
        const err = error instanceof Error ? error : new Error(String(error));
        trace("outbound_failed", { failed_stage: stage, error: err.message, stack: err.stack,
          outcome: outboundStarted ? "requires_reconciliation" : "retryable" });
        throw err;
      }
    })();
    attempts.set(key, task);
    return task;
  };
}

export const handleAthosTestInbound = createAthosTestHandler();

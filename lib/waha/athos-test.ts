import { createHash } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { WahaEnvelope } from "@/lib/waha/ingest";
import { sendWAHA } from "@/lib/waha/send";
import { parseWahaMessageId } from "@/lib/waha/message-id";

export const ATHOS_TEST_ORG = "036bb1d5-2cb6-4346-9c19-3dbb1c0d0433";
export const ATHOS_TEST_SESSION = "15ed07d7-57f9-4746-a543-d8768003848b";

/**
 * URL OFICIAL do cardápio do tenant sandbox (Tortas do Calmon).
 *
 * É DADO DETERMINÍSTICO DE CONFIGURAÇÃO DO TENANT — não é saída de
 * `athos_menu_lookup` nem de chamada externa. O outbound usa este valor
 * direto; o lookup paralelo é só enriquecimento (app_name + validação
 * sandbox) e FALHA como warning, nunca bloqueia o envio.
 *
 * Justificativa (regra do cardápio Sarah): o cliente pede o cardápio e a
 * URL já está configurada — esperar um lookup externo adicional que pode
 * dar Gateway Timeout é exatamente o bug que esta correção tira do caminho
 * crítico. Veja o teste B (`menu_url + Gateway Timeout → URL enviada`).
 */
export const ATHOS_TEST_MENU_URL = "https://cardapio.sistemaathos.com.br/tortasdocalmon";
export const ATHOS_TEST_APP_NAME = "Tortas do Calmon";

/** Teto curto para o lookup de enriquecimento: falha em 1.5s em vez de esperar 8s+ do Supabase. */
const ATHOS_LOOKUP_TIMEOUT_MS = 1500;

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
    console.info(JSON.stringify({
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
      // === FASE 1: URL DETERMINÍSTICO DO TENANT ===
      // A URL é config do tenant (sandbox homolog), não saída de lookup.
      // Já temos o que precisamos para responder o cliente antes de qualquer
      // chamada externa. O outbound começa a partir daqui, sem depender
      // de Supabase.
      const menuUrl = ATHOS_TEST_MENU_URL;
      trace("menu_url_loaded", {
        menu_url: menuUrl,
        tenant: ATHOS_TEST_APP_NAME,
        source: "tenant_config",
      });

      // === FASE 2: ENRIQUECIMENTO BEST-EFFORT ===
      // Apenas para (a) confirmar nome do app para a trace e (b) validar
      // que o registro DB ainda está marcado como sandbox. Teto curto de
      // 1.5s para falhar rápido. Falha aqui é WARNING não-fatal — não
      // bloqueia o outbound. O link segue sendo a constante acima.
      let lookupStatus: "ok" | "timeout" | "error" | "not_sandbox" = "ok";
      try {
        const { data, error } = await admin.from("food_commerce_settings")
          .select("app_name, settings")
          .eq("organization_id", session.organization_id).eq("is_enabled", true)
          .order("updated_at", { ascending: false }).limit(1)
          .abortSignal(AbortSignal.timeout(ATHOS_LOOKUP_TIMEOUT_MS))
          .maybeSingle();
        if (error) {
          lookupStatus = error.message?.toLowerCase().includes("timeout") || error.code === "504"
            ? "timeout" : "error";
          trace("athos_menu_lookup_failed", {
            correlation_id: requestId ?? key,
            non_fatal: true,
            error: `${error.code ?? ""} ${error.message}`,
            lookup_status: lookupStatus,
            note: "URL já conhecida via tenant_config — outbound prossegue sem enriquecimento.",
          });
        } else {
          const settings = data?.settings as Record<string, unknown> | undefined;
          if (settings?.environment !== "sandbox") {
            lookupStatus = "not_sandbox";
            trace("athos_menu_lookup_failed", {
              correlation_id: requestId ?? key,
              non_fatal: true,
              error: "athos_test_requires_sandbox",
              lookup_status: lookupStatus,
              note: "ambiente DB não é sandbox — outbound usa URL determinística do tenant_config.",
            });
          } else {
            trace("menu_lookup_finished", {
              app_name: data?.app_name ?? null,
              lookup_status: "ok",
              lookup_timeout_ms: ATHOS_LOOKUP_TIMEOUT_MS,
            });
          }
        }
      } catch (error) {
        // Cobre abort do timeout, JSON malformado, etc. Nunca propaga.
        lookupStatus = error instanceof Error && /timeout|abort/i.test(error.message)
          ? "timeout" : "error";
        trace("athos_menu_lookup_failed", {
          correlation_id: requestId ?? key,
          non_fatal: true,
          error: error instanceof Error ? error.message : String(error),
          lookup_status: lookupStatus,
          note: "URL já conhecida via tenant_config — outbound prossegue sem enriquecimento.",
        });
      }

      // === FASE 3: OUTBOUND IMEDIATO ===
      try {
        stage = "outbound_started";
        trace(stage, {
          tenant: ATHOS_TEST_APP_NAME,
          menu_url_source: "tenant_config",
          enrichment_lookup: lookupStatus,
        });
        outboundStarted = true;
        const result = await deps.send({ sessionName: session.waha_session_name,
          chatId, text: `Olá! 😊 Aqui está nosso cardápio:\n${menuUrl}`,
          timeoutMs: 10000 });
        const outboundId = parseWahaMessageId(result);
        if (!outboundId) throw new Error("athos_outbound_acceptance_unconfirmed");
        trace("outbound_success", {
          outbound_id: outboundId,
          delivery: "provider_accepted",
          menu_url_sent: menuUrl,
          enrichment_lookup: lookupStatus,
        });
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

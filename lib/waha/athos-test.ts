import { createHash } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { WahaEnvelope } from "@/lib/waha/ingest";
import { sendWAHA } from "@/lib/waha/send";
import { parseWahaMessageId } from "@/lib/waha/message-id";
import { buildMenuReply, isMenuRequest } from "@/lib/agent-engine/edge/crm/menu-context";

export const ATHOS_TEST_ORG = "036bb1d5-2cb6-4346-9c19-3dbb1c0d0433";
export const ATHOS_TEST_SESSION = "15ed07d7-57f9-4746-a543-d8768003848b";

/**
 * URL OFICIAL do cardápio do tenant sandbox (Tortas do Calmon).
 *
 * É DADO DETERMINÍSTICO DE CONFIGURAÇÃO DO TENANT — não é saída de
 * `athos_menu_lookup` nem de chamada externa. O outbound usa este valor
 * direto; o lookup paralelo é só enriquecimento (app_name + validação
 * sandbox) e NUNCA bloqueia o envio.
 *
 * TRAVA DETERMINÍSTICA: este URL só pode ser usado pelo driver
 * `createAthosTestHandler` quando:
 *   - `process.env.ATHOS_TEST_MODE === "true"`
 *   - `session.organization_id === ATHOS_TEST_ORG`
 *   - `session.id === ATHOS_TEST_SESSION`
 * Ver `isAthosTestSession` e o teste "D. tenant diferente NUNCA recebe
 * ATHOS_TEST_MENU_URL".
 */
export const ATHOS_TEST_MENU_URL = "https://cardapio.sistemaathos.com.br/tortasdocalmon";
export const ATHOS_TEST_APP_NAME = "Tortas do Calmon";

/** Teto curto para o lookup de enriquecimento. Falha após 1.5s. */
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

/**
 * Nome curto só para apresentação no sandbox. Não altera o contato persistido.
 * Usa o primeiro token do push-name e normaliza a capitalização.
 */
export function presentContactName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim().split(/\s+/)[0]?.trim();
  if (!token) return null;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
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

/** Resultado do lookup de enriquecimento — nunca propaga como throw. */
type EnrichmentStatus = "ok" | "timeout" | "error" | "not_sandbox";
interface EnrichmentResult {
  status: EnrichmentStatus;
  app_name?: string | null;
  error?: string;
}

/** Lê o cardápio oficial via `food_commerce_settings` com teto de tempo.
 *  Função pura: sempre resolve (nunca rejeita). Caller trata status. */
async function runMenuEnrichment(
  admin: Admin,
  organizationId: string,
  correlationId: string,
  trace: ReturnType<typeof athosTrace>,
): Promise<EnrichmentResult> {
  try {
    const { data, error } = await admin.from("food_commerce_settings")
      .select("app_name, settings")
      .eq("organization_id", organizationId).eq("is_enabled", true)
      .order("updated_at", { ascending: false }).limit(1)
      .abortSignal(AbortSignal.timeout(ATHOS_LOOKUP_TIMEOUT_MS))
      .maybeSingle();
    if (error) {
      const status: EnrichmentStatus = error.code === "504" || /timeout/i.test(error.message)
        ? "timeout" : "error";
      trace("athos_menu_lookup_failed", {
        correlation_id: correlationId,
        non_fatal: true,
        enrichment: status,
        error: `${error.code ?? ""} ${error.message}`,
        note: "URL já é tenant_config — outbound prossegue sem enriquecimento.",
      });
      return { status, error: error.message };
    }
    const settings = data?.settings as Record<string, unknown> | undefined;
    if (settings?.environment !== "sandbox") {
      trace("athos_menu_lookup_failed", {
        correlation_id: correlationId,
        non_fatal: true,
        enrichment: "not_sandbox",
        error: "athos_test_requires_sandbox",
        note: "DB não marca sandbox — outbound usa URL determinística do tenant_config.",
      });
      return { status: "not_sandbox", error: "athos_test_requires_sandbox" };
    }
    return { status: "ok", app_name: data?.app_name ?? null };
  } catch (error) {
    const status: EnrichmentStatus = error instanceof Error && /timeout|abort/i.test(error.message)
      ? "timeout" : "error";
    trace("athos_menu_lookup_failed", {
      correlation_id: correlationId,
      non_fatal: true,
      enrichment: status,
      error: error instanceof Error ? error.message : String(error),
      note: "URL já é tenant_config — outbound prossegue sem enriquecimento.",
    });
    return { status, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Single-process homologation only. Concurrent copies share the same outcome.
 * Ambiguous outbound failures remain failed until operator reconciliation.
 * This temporary mode is not a production send ledger and cannot use replicas.
 */
export function createAthosTestHandler(deps = { send: sendWAHA }) {
  const attempts = new Map<string, Promise<boolean>>();
  return async (admin: Admin, session: AthosTestSession, envelope: WahaEnvelope,
    startedAt = Date.now(), requestId?: string): Promise<boolean> => {
    // GUARDA DETERMINÍSTICA — antes de QUALQUER acesso a admin.from ou
    // leitura da constante ATHOS_TEST_MENU_URL: este driver só atende a
    // homologação Tortas do Calmon. Outros tenants/dev/orgs recebem `false`
    // e zero side-effects (sem DB, sem WAHA, sem trace com URL sensível).
    if (!isAthosTestSession(session)) return false;
    const p = envelope.payload;
    if (!p || p.fromMe || !["message", "message.any"].includes(envelope.event ?? "")) return false;
    if (envelope.session !== session.waha_session_name) throw new Error("athos_session_mismatch");
    if (!p.id || !p.from || !/^[0-9]+@(c\.us|s\.whatsapp\.net|lid)$/.test(p.from)) return false;
    const body = p.body ?? "";
    if (!body && !p.hasMedia && !p.mediaUrl && !p.media?.url) return false;
    const chatId = p.from;

    const key = createHash("sha256").update(`${session.organization_id}:${session.id}:${p.from}:${p.id}`).digest("hex");
    const correlationId = requestId ?? key;
    const trace = athosTrace(correlationId, startedAt);

    // Esta guarda decide somente se o fast path do cardápio deve interceptar.
    // Mensagens como "somos em 6 pessoas" voltam `false` e seguem para o
    // pipeline normal da Sarah, que conduz a venda com a persona comercial.
    if (!isMenuRequest(body)) {
      trace("not_menu_intent", {
        body_preview: body.slice(0, 80),
        reason: "pipeline_normal_handles",
      });
      return false;
    }

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
      trace("menu_url_loaded", {
        menu_url: ATHOS_TEST_MENU_URL,
        tenant: ATHOS_TEST_APP_NAME,
        source: "tenant_config",
      });

      // === FASE 2: ENRICHMENT EM PARALELO ===
      // Dispara o lookup MAS NÃO espera — outbound começa imediatamente.
      // A promise fica em vôo durante o envio; só é resolvida/aguardada
      // depois, para o trace final. Falha do enrichment NUNCA bloqueia o
      // outbound (é best-effort, com catch interno).
      const enrichmentPromise = runMenuEnrichment(admin, session.organization_id, correlationId, trace)
        .catch((err): EnrichmentResult => ({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        }));

      // === FASE 3: OUTBOUND IMEDIATO ===
      try {
        stage = "outbound_started";
        trace(stage, {
          menu_url_source: "tenant_config",
          enrichment: "in_flight",
        });
        outboundStarted = true;
        const rawPushName = p._data?.notifyName ?? p._data?.pushName ?? null;
        const contactName = presentContactName(rawPushName);
        const text = buildMenuReply(ATHOS_TEST_MENU_URL, contactName);
        const result = await deps.send({
          sessionName: session.waha_session_name,
          chatId,
          text,
          timeoutMs: 10000,
        });
        const outboundId = parseWahaMessageId(result);
        if (!outboundId) throw new Error("athos_outbound_acceptance_unconfirmed");
        trace("outbound_success", {
          outbound_id: outboundId,
          delivery: "provider_accepted",
          menu_url_sent: ATHOS_TEST_MENU_URL,
          copy_source: "buildMenuReply (canonical)",
        });
        // === FASE 4: AGUARDA ENRICHMENT PARA TRACE ===
        // Outbound JÁ foi aceito pelo WAHA — esperar o enrichment aqui
        // não atrasa o cliente. Limita o tempo de espera com um teto
        // curto para evitar pendurar caso o lookup nunca resolva.
        const enrichment = await Promise.race([
          enrichmentPromise,
          new Promise<EnrichmentResult>((resolve) => setTimeout(
            () => resolve({ status: "timeout", error: "enrichment_post_send_timeout" }),
            ATHOS_LOOKUP_TIMEOUT_MS,
          )),
        ]);
        trace("menu_enrichment_finished", {
          enrichment_status: enrichment.status,
          app_name: enrichment.app_name ?? null,
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

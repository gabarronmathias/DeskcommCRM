/**
 * GET /api/v1/cron/waha-sessions-list
 *
 * Rota TEMPORÁRIA de diagnóstico (2026-09-04). Lista TODAS as sessões no
 * WAHA Plus, incluindo nome, status, engine, me.id (jid), me.pn, me.lid.
 *
 * Necessária porque o canal ativo da org gabarron-mathias tem
 * `waha_session_name = "default"` e precisamos descobrir o nome REAL
 * da sessão WORKING que corresponde ao número 5512988008808.
 *
 * Auth: bearer em {INTERNAL_CRON_SECRET, INTERNAL_SECRET, CRON_SECRET}.
 *
 * REMOVER após a auditoria (commit revert) — não deve ficar no caminho
 * de produção. Marcado com prefixo `cron/` só para reusar a auth de cron.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { isAuthorizedProspectingCron } from "@/lib/prospecting/cron-auth";
import { getWahaClient } from "@/lib/waha/client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function handle(request: Request): Promise<Response> {
  const requestId = randomUUID();
  if (!isAuthorizedProspectingCron(request)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  const waha = getWahaClient();
  if (!waha) {
    return fail("waha_not_configured", "WAHA env ausente (WAHA_API_BASE_URL/WAHA_API_KEY).", 503, {
      requestId,
    });
  }

  // O cliente WAHA expõe getSessionQr(name) e getProfilePictureUrl(session, chatId).
  // Para listar TODAS as sessões, usamos a rota REST direto: GET /api/sessions
  // (o cliente não tem um wrapper para list-all).
  const baseUrl = process.env.WAHA_API_BASE_URL ?? "";
  const apiKey = process.env.WAHA_API_KEY ?? "";
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/sessions`, {
      method: "GET",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      // WAHA list sessions pode demorar; 20s é seguro para 1-10 sessões.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("waha_unreachable", `WAHA fetch failed: ${message.slice(0, 200)}`, 502, {
      requestId,
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return fail("waha_error", `WAHA ${res.status}: ${body.slice(0, 400)}`, 502, { requestId });
  }
  const raw = (await res.json()) as unknown;
  const sessions = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown })?.data) ? (raw as { data: unknown[] }).data : [];

  // Não devolve API key. Reduz a campos não-sensiveis.
  const out = (sessions as Array<Record<string, unknown>>).map((s) => ({
    name: typeof s.name === "string" ? s.name : null,
    status: typeof s.status === "string" ? s.status : null,
    engine: typeof s.engine === "string" ? s.engine : null,
    me_id: typeof (s.me as { id?: unknown } | undefined)?.id === "string"
      ? (s.me as { id: string }).id
      : null,
    me_pn: typeof (s.me as { pn?: unknown } | undefined)?.pn === "string"
      ? (s.me as { pn: string }).pn
      : null,
    me_lid: typeof (s.me as { lid?: unknown } | undefined)?.lid === "string"
      ? (s.me as { lid: string }).lid
      : null,
    me_pushname: typeof (s.me as { pushName?: unknown } | undefined)?.pushName === "string"
      ? (s.me as { pushName: string }).pushName
      : null,
  }));

  return ok(
    { count: out.length, sessions: out },
    { requestId },
  );
}

export async function GET(request: Request) {
  return handle(request);
}
export async function POST(request: Request) {
  return handle(request);
}

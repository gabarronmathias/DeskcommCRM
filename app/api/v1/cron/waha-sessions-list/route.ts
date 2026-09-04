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
 * Auth: bearer em DEBUG_TOKEN (env de produção) OU nos cron secrets.
 * REMOVER após a auditoria (commit revert).
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { isAuthorizedProspectingCron } from "@/lib/prospecting/cron-auth";
import { getWahaClient } from "@/lib/waha/client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function isDebugAuthorized(request: Request): boolean {
  const expected = (process.env.DEBUG_TOKEN ?? "").trim();
  if (!expected) return false;
  const bearer = request.headers.get("authorization") ?? "";
  if (!bearer.startsWith("Bearer ")) return false;
  return bearer.slice(7).trim() === expected;
}

async function handle(request: Request): Promise<Response> {
  const requestId = randomUUID();
  // Aceita OU o DEBUG_TOKEN (env de produção) OU os cron secrets (compat).
  if (!isDebugAuthorized(request) && !isAuthorizedProspectingCron(request)) {
    return fail("forbidden", "Token ausente ou inválido.", 403, { requestId });
  }
  const baseUrl = process.env.WAHA_API_BASE_URL ?? "";
  const apiKey = process.env.WAHA_API_KEY ?? "";
  if (!baseUrl || !apiKey) {
    return fail("waha_not_configured", "WAHA env ausente.", 503, { requestId });
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/sessions`, {
      method: "GET",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
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
  const sessions = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { data?: unknown })?.data)
      ? (raw as { data: unknown[] }).data
      : [];

  // Não devolve API key. Reduz a campos não-sensiveis.
  const out = (sessions as Array<Record<string, unknown>>).map((s) => ({
    name: typeof s.name === "string" ? s.name : null,
    status: typeof s.status === "string" ? s.status : null,
    engine: typeof s.engine === "string" ? s.engine : null,
    me_id:
      typeof (s.me as { id?: unknown } | undefined)?.id === "string"
        ? (s.me as { id: string }).id
        : null,
    me_pn:
      typeof (s.me as { pn?: unknown } | undefined)?.pn === "string"
        ? (s.me as { pn: string }).pn
        : null,
    me_lid:
      typeof (s.me as { lid?: unknown } | undefined)?.lid === "string"
        ? (s.me as { lid: string }).lid
        : null,
    me_pushname:
      typeof (s.me as { pushName?: unknown } | undefined)?.pushName === "string"
        ? (s.me as { pushName: string }).pushName
        : null,
  }));

  return ok({ count: out.length, sessions: out }, { requestId });
}

export async function GET(request: Request) {
  return handle(request);
}
export async function POST(request: Request) {
  return handle(request);
}

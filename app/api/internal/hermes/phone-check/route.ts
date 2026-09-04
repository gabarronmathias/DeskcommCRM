/**
 * POST /api/internal/hermes/phone-check
 *
 * Operação ADMINISTRATIVA do Hermes. Confirma se um telefone tem WhatsApp
 * ativo, via checkPhoneExists do cliente WAHA oficial.
 *
 * NÃO envia mensagem. Apenas verifica.
 *
 * Auth: bearer HERMES_API_TOKEN (timing-safe).
 *
 * Body:
 *   { phone: "5512..." | "(12) 9xxxx-xxxx" | "+55 12 ...", session?: string }
 *
 * Resposta 200:
 *   { data: { numberExists, chatId, pn, phoneNormalized, source: "waha" } }
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { getWahaClient } from "@/lib/waha/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function isAuthorized(request: Request): boolean {
  const expected = (env.HERMES_API_TOKEN ?? "").trim();
  if (!expected) return false;
  const bearer = request.headers.get("authorization") ?? "";
  if (!bearer.startsWith("Bearer ")) return false;
  const got = bearer.slice(7).trim();
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i += 1) {
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

const DEFAULT_SESSION = "default";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!isAuthorized(req)) {
    return fail("forbidden", "HERMES_API_TOKEN ausente ou invalido.", 401, { requestId });
  }

  let body: { phone?: unknown; session?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return fail("invalid_json", "body precisa ser JSON", 400, { requestId });
  }
  if (typeof body.phone !== "string" || body.phone.trim().length < 8) {
    return fail("invalid_phone", "phone deve ser string com pelo menos 8 digitos", 400, { requestId });
  }
  const session = typeof body.session === "string" && body.session.trim() ? body.session.trim() : DEFAULT_SESSION;
  const phoneRaw = body.phone.trim();

  // Normalizar para E.164 (BR default se 10-11 dígitos)
  const digits = phoneRaw.replace(/\D/g, "");
  let normalized: string;
  if (digits.length === 10 || digits.length === 11) {
    normalized = `+55${digits}`;
  } else if (digits.length >= 12 && digits.length <= 15) {
    normalized = `+${digits}`;
  } else {
    return fail("invalid_phone_format", `phone com ${digits.length} digitos nao normalizavel`, 400, { requestId, details: { digits } });
  }

  try {
    const waha = getWahaClient();
    if (!waha) {
      return fail("waha_not_configured", "WAHA_API_BASE_URL/KEY ausentes em producao", 503, { requestId });
    }
    const result = await waha.checkPhoneExists(session, normalized);
    return ok(
      {
        numberExists: result.numberExists,
        chatId: result.chatId,
        pn: result.pn,
        phoneNormalized: normalized,
        source: "waha",
        session,
      },
      { requestId },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "waha_check_failed";
    return fail("waha_check_failed", message, 502, { requestId, details: { phoneNormalized: normalized, session } });
  }
}

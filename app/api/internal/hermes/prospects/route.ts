/**
 * POST /api/internal/hermes/prospects
 *
 * Endpoint dedicado ao Hermes (operador comercial B2B da GB). Recebe um
 * prospect CURADO e delega TUDO ao `importProspect` oficial. NÃO envia
 * WhatsApp, NÃO cria fila paralela, NÃO duplica regras de negócio.
 *
 * Auth: bearer `HERMES_API_TOKEN` (env em Production). Timing-safe.
 *
 * Body:
 *   { prospect: PublicBusinessProspect, requestId?: string }
 *
 * Resposta 200:
 *   { data: { outcome, company, phone, leadId?, queueId?, reason? } }
 *
 * Outcomes:
 *   - "created"   → contact + lead + conversation + queue row criados
 *   - "duplicate" → já existe (idempotente: source_id, phone, etc.)
 *   - "invalid"   → telefone inválido ou shape do prospect inválido
 *
 * 401 se bearer ausente/inválido.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { importProspect } from "@/lib/prospecting/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  prospect: z.object({
    source: z.literal("manual_curated"),
    sourceId: z.string().min(1).max(200),
    sourceUrl: z.string().url().max(500).nullable(),
    placeId: z.string().max(200),
    companyName: z.string().min(1).max(200),
    category: z.string().min(1).max(80),
    phoneRaw: z.string().min(1).max(40),
    website: z.string().url().max(500).nullable(),
    address: z.string().max(500),
    neighborhood: z.string().max(200).nullable(),
    city: z.string().min(1).max(80),
    state: z.string().min(2).max(2),
    mapsUrl: z.string().url().max(500).nullable(),
    rating: z.number().min(0).max(5).nullable(),
    reviewCount: z.number().int().min(0).nullable(),
    businessStatus: z.string().min(1).max(40),
    primaryType: z.string().max(80).nullable(),
    types: z.array(z.string().max(80)).max(20),
    campaign: z.string().min(1).max(80),
  }),
  requestId: z.string().uuid().optional(),
});

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function authorize(req: NextRequest): boolean {
  const expected = env.HERMES_API_TOKEN;
  if (!expected) return false;
  const bearer = req.headers.get("authorization");
  if (!bearer) return false;
  const match = /^Bearer\s+(.+)$/i.exec(bearer.trim());
  if (!match) return false;
  return timingSafeEq(match[1]!.trim(), expected);
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!authorize(req)) {
    return fail("unauthenticated", "Bearer HERMES_API_TOKEN ausente ou inválido.", 401, { requestId });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Payload inválido.", 422, {
      requestId,
      details: { errors: parsed.error.flatten() },
    });
  }

  const supabase = createAdminClient();
  try {
    // importProspect faz TUDO: dedupe, contact, lead, conversation, queue
    // row + idempotency_key + metadata.campaign. O Hermes não duplica nada.
    // O `campaign` do prospect sobrescreve a ativa — é o ponto de entrada
    // para campanhas de teste/integracao (ex.: gb-hermes-integration-test)
    // sem alterar o env `PROSPECTING_CAMPAIGN` em produção.
    const result = await importProspect(supabase, parsed.data.prospect, {
      campaign: parsed.data.prospect.campaign,
    });
    return ok(
      {
        outcome: result.outcome,
        company: result.company,
        phone: result.phone,
        category: result.category,
        city: result.city,
        ...(result.leadId ? { leadId: result.leadId } : {}),
        ...(result.queueId ? { queueId: result.queueId } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      },
      { requestId },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("internal_error", message, 500, { requestId });
  }
}

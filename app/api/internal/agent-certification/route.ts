/**
 * POST /api/internal/agent-certification — rota TEMPORÁRIA de certificação
 * E2E do agente Sarah (foodservice). NUNCA deve virar API genérica.
 *
 * Escopo fechado (fail-closed):
 *   - organization: SEMPRE gabarron-mathias (slug hard-coded via TARGET_ORG_SLUG);
 *   - agent: SEMPRE "Sarah" publicado (published_version_id preenchido);
 *   - is_dry_run: SEMPRE true (nunca chama WAHA, nunca cria messages.outbound,
 *     nunca enfileira prospecting_outbound_queue);
 *   - inputs aceitos: { sample_message, sample_contact? { name?, phone? } }.
 *
 * Proteção:
 *   - Authorization: Bearer <INTERNAL_CRON_SECRET> (timing-safe)
 *   - x-cron-secret: <INTERNAL_CRON_SECRET> (alias)
 *
 * Reuso: delega para `runAgent` em lib/ai/runtime/agent.ts — a MESMA função
 * usada por /api/internal/agents/run (Fase 0, runtime S-13.08). Lê a versão
 * publicada atual de Sarah, monta o histórico mínimo, executa o loop do
 * agente (modelo + tools + guardrails) e devolve o dry-run.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { TARGET_ORG_SLUG } from "@/lib/prospecting/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const bodySchema = z.object({
  sample_message: z.string().min(1).max(4000),
  sample_contact: z
    .object({
      name: z.string().max(120).optional(),
      phone: z.string().max(40).optional(),
    })
    .optional(),
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
  const expected = env.INTERNAL_CRON_SECRET;
  if (!expected) return false;
  const bearer = req.headers.get("authorization");
  if (bearer) {
    const match = /^Bearer\s+(.+)$/i.exec(bearer.trim());
    if (match && timingSafeEq(match[1]!.trim(), expected)) return true;
  }
  const xCron = req.headers.get("x-cron-secret");
  if (xCron && timingSafeEq(xCron, expected)) return true;
  return false;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  if (!authorize(req)) {
    return fail("unauthenticated", "Internal cron secret missing or invalid.", 401, {
      requestId,
    });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: { errors: parsed.error.flatten() },
    });
  }

  const admin = createAdminClient();

  // 1) Resolver org SEMPRE por slug gabarron-mathias (fail-closed: nada arbitrário).
  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("id, slug")
    .eq("slug", TARGET_ORG_SLUG)
    .maybeSingle();
  if (orgErr || !org) {
    return fail("not_found", `Org ${TARGET_ORG_SLUG} não encontrada.`, 404, { requestId });
  }

  // 2) Encontrar Sarah publicada para a org.
  const { data: agent, error: agentErr } = await admin
    .from("ai_agents")
    .select("id, name, published_version_id, archived_at")
    .eq("organization_id", org.id)
    .eq("name", "Sarah")
    .is("archived_at", null)
    .not("published_version_id", "is", null)
    .maybeSingle();
  if (agentErr || !agent) {
    return fail(
      "not_found",
      "Agente Sarah (publicado) não encontrado para a org gabarron-mathias.",
      404,
      { requestId },
    );
  }

  // 3) Ler a versão publicada e o canal dela.
  const { data: version, error: versionErr } = await admin
    .from("ai_agent_versions")
    .select("id, agent_id, organization_id, status, channel_session_id, provider, model")
    .eq("id", agent.published_version_id)
    .eq("agent_id", agent.id)
    .eq("organization_id", org.id)
    .eq("status", "published")
    .maybeSingle();
  if (versionErr || !version) {
    return fail("not_found", "Versão publicada de Sarah não encontrada.", 404, { requestId });
  }
  if (!version.channel_session_id) {
    return fail(
      "invalid_state",
      "Versão publicada de Sarah não tem channel_session_id.",
      422,
      { requestId },
    );
  }

  // 4) Criar a row ai_agent_runs com is_dry_run=true.
  //    O `runAgent` abaixo carrega a row, promove a 'running', executa, e finaliza.
  const startedAt = new Date().toISOString();
  const { data: runRow, error: runErr } = await admin
    .from("ai_agent_runs")
    .insert({
      organization_id: org.id,
      agent_id: agent.id,
      agent_version_id: version.id,
      conversation_id: null,
      contact_id: null,
      channel_session_id: version.channel_session_id,
      inbound_message_id: null,
      outbound_message_id: null,
      status: "running",
      is_dry_run: true,
      started_at: startedAt,
    })
    .select("id")
    .single();
  if (runErr || !runRow) {
    return fail(
      "internal_error",
      `Falha ao criar run: ${runErr?.message ?? "no_row"}`,
      500,
      { requestId },
    );
  }

  // 5) Executar a MESMA função usada por /api/internal/agents/run.
  let result: unknown;
  try {
    const { runAgent } = await import("@/lib/ai/runtime/agent");
    result = await runAgent({
      runId: runRow.id,
      override: {
        sampleMessage: parsed.data.sample_message,
        sampleContact: parsed.data.sample_contact,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("runtime_error", message, 500, { requestId, details: { run_id: runRow.id } });
  }

  return ok(
    {
      run_id: runRow.id,
      organization: { id: org.id, slug: org.slug },
      agent: { id: agent.id, name: agent.name },
      version: { id: version.id, provider: version.provider, model: version.model },
      sample_message: parsed.data.sample_message,
      sample_contact: parsed.data.sample_contact ?? null,
      result,
    },
    { requestId },
  );
}

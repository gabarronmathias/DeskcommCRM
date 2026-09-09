/**
 * POST /api/internal/debug/dispatch-queue-row
 *
 * ONE-SHOT para o Mavis (operador) inserir manualmente uma queue row
 * (sarha_proativa retroativo OU follow-up customizado para lead quente).
 *
 * Auth: `INTERNAL_CRON_SECRET` (Bearer ou x-cron-secret).
 *
 * Body:
 *   {
 *     leadId: string (UUID obrigatório),
 *     body: string (texto da mensagem WhatsApp; >=10 chars, <=1000),
 *     kind: "opening" | "followup" (default: "followup"),
 *     delayMinutes: number (default: 2; max 60),
 *     metadata?: object (mesclado com defaults — `dispatched_by: "mavis"` adicionado)
 *   }
 *
 * Resposta 200:
 *   { data: { queueId, scheduledFor, kind, leadId, leadTitle } }
 *
 * REMOVER após uso (não é API de produção; é ferramenta de operação).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { fail, ok } from "@/lib/api/wrappers";
import { isAuthorizedProspectingCron } from "@/lib/prospecting/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { activeCampaign, OPENING_MESSAGE } from "@/lib/prospecting/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!isAuthorizedProspectingCron(request)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail("invalid_request", "Body must be JSON.", 400, { requestId });
  }
  const leadId = typeof body.leadId === "string" ? body.leadId : "";
  if (!UUID_RX.test(leadId)) {
    return fail("invalid_request", "leadId must be UUID.", 400, { requestId });
  }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (text.length < 10 || text.length > 1000) {
    return fail("invalid_request", "body must be 10..1000 chars.", 400, { requestId });
  }
  const kind: "opening" | "followup" = body.kind === "opening" ? "opening" : "followup";
  const delayMinutes = Math.max(0, Math.min(60, Number.parseInt(String(body.delayMinutes ?? "2"), 10) || 2));
  const userMetadata = (body.metadata && typeof body.metadata === "object" ? body.metadata : {}) as Record<string, unknown>;

  const admin = createAdminClient();
  // 1) lead + contact
  const { data: lead, error: leadErr } = await admin
    .from("crm_leads")
    .select("id, title, contact_id, organization_id, custom_fields")
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr || !lead) {
    return fail("lead_not_found", leadErr?.message ?? "no row", 404, { requestId });
  }
  if (!lead.contact_id) {
    return fail("lead_no_contact", "lead sem contact_id", 422, { requestId });
  }
  // 2) conversation
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select("id")
    .eq("contact_id", lead.contact_id)
    .eq("organization_id", lead.organization_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (convErr || !conv) {
    return fail("conversation_not_found", convErr?.message ?? "no row", 404, { requestId });
  }
  // 3) channel session WORKING
  const { data: session, error: sessionErr } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", lead.organization_id)
    .eq("provider", "waha")
    .eq("status", "WORKING")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sessionErr || !session) {
    return fail("session_not_working", sessionErr?.message ?? "no row", 503, { requestId });
  }
  // 4) insert
  const scheduledFor = new Date(Date.now() + delayMinutes * 60_000).toISOString();
  const idempotencyKey = `mavis_dispatch:${lead.contact_id}:${randomUUID()}`;
  const metadata = {
    ...userMetadata,
    dispatched_by: "mavis",
    dispatched_at: new Date().toISOString(),
    request_id: requestId,
  };
  const { data: row, error: insertErr } = await admin
    .from("prospecting_outbound_queue")
    .insert({
      organization_id: lead.organization_id,
      lead_id: lead.id,
      contact_id: lead.contact_id,
      conversation_id: conv.id,
      channel_session_id: session.id,
      kind,
      flow_name: "Mavis dispatch one-shot",
      message_body: text,
      status: "pending",
      scheduled_for: scheduledFor,
      idempotency_key: idempotencyKey,
      metadata,
    })
    .select("id, scheduled_for, kind, lead_id")
    .single();
  if (insertErr || !row) {
    return fail("insert_failed", insertErr?.message ?? "no row", 500, { requestId });
  }
  return ok(
    {
      queueId: row.id,
      scheduledFor: row.scheduled_for,
      kind: row.kind,
      leadId: row.lead_id,
      leadTitle: lead.title,
      delayMinutes,
      activeCampaign: activeCampaign(),
      openingMessageTemplate: kind === "opening" ? OPENING_MESSAGE(String(lead.title ?? "")) : null,
    },
    { requestId },
  );
}

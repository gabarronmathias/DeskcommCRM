/**
 * GET /api/internal/debug/list-queue-recent?since=YYYY-MM-DD&limit=50
 *
 * ONE-SHOT para o Mavis inspecionar queue rows recentes (todas as que foram
 * inseridas ou atualizadas), com join de lead/contact. Útil para auditar
 * quem está pending, quem foi sent, quem falhou e o erro.
 *
 * Auth: `INTERNAL_CRON_SECRET`.
 *
 * Resposta 200:
 *   { data: { count, rows: [{id, status, kind, scheduled_for, sent_at, error_code, error_message, crm_message_id, lead_title, contact_phone, metadata, attempts}] } }
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { fail, ok } from "@/lib/api/wrappers";
import { isAuthorizedProspectingCron } from "@/lib/prospecting/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!isAuthorizedProspectingCron(request)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  const url = new URL(request.url);
  const since = url.searchParams.get("since") || new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const limit = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get("limit") || "50", 10)));
  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("prospecting_outbound_queue")
    .select("id, status, kind, scheduled_for, sent_at, error_code, error_message, crm_message_id, lead_id, contact_id, metadata, idempotency_key, attempts, max_attempts, created_at, updated_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  const leadIds = Array.from(new Set((rows ?? []).map((r) => r.lead_id).filter(Boolean)));
  const contactIds = Array.from(new Set((rows ?? []).map((r) => r.contact_id).filter(Boolean)));
  let leadById = new Map();
  let contactById = new Map();
  if (leadIds.length) {
    const { data: leads } = await admin.from("crm_leads").select("id, title, contact_id").in("id", leadIds);
    for (const l of leads ?? []) leadById.set(l.id, l);
  }
  if (contactIds.length) {
    const { data: contacts } = await admin.from("contacts").select("id, phone_number, push_name, display_name").in("id", contactIds);
    for (const c of contacts ?? []) contactById.set(c.id, c);
  }
  const out = (rows ?? []).map((r) => {
    const lead = leadById.get(r.lead_id);
    const contact = contactById.get(r.contact_id);
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      status: r.status,
      kind: r.kind,
      scheduled_for: r.scheduled_for,
      sent_at: r.sent_at,
      error_code: r.error_code,
      error_message: r.error_message,
      crm_message_id: r.crm_message_id,
      attempts: r.attempts,
      max_attempts: r.max_attempts,
      lead_id: r.lead_id,
      lead_title: lead?.title ?? null,
      contact_id: r.contact_id,
      contact_phone: contact?.phone_number ?? null,
      contact_name: contact?.push_name || contact?.display_name || null,
      metadata: meta,
      idempotency_key: r.idempotency_key,
      sarah_proativa: meta.sarah_proativa === true,
      mavis_as_sarah: meta.mavis_as_sarah === true,
      campaign: typeof meta.campaign === "string" ? meta.campaign : null,
      company: typeof meta.company === "string" ? meta.company : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });
  return ok({ count: out.length, since, rows: out }, { requestId });
}

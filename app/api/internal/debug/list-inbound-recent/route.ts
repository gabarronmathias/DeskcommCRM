/**
 * GET /api/internal/_debug/list-inbound-recent?since=YYYY-MM-DD&limit=50
 *
 * Rota ONE-SHOT para o Mavis (operador) inspecionar as últimas mensagens
 * inbound em uma janela de tempo, com join de contact/lead. Usada pra
 * continuar manualmente conversas quentes (lead respondeu autoresposta do
 * próprio WhatsApp Business e a Sarah filtrou corretamente — mas o humano
 * ainda não mandou a 2ª msg; Mavis acompanha pra agir proativamente).
 *
 * Auth: `INTERNAL_CRON_SECRET` via header `Authorization: Bearer` ou `x-cron-secret`
 *      (mesmo gate das outras rotas internas).
 *
 * NÃO envia nada. NÃO mexe em estado. Apenas LÊ.
 *
 * Resposta 200:
 *   { data: { count, messages: [{at, contact_name, contact_phone, lead_id, lead_title, direction, body, status, external_id}] } }
 *
 * REMOVER após uso (não é API de produção; é ferramenta de operação).
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
  const { data: msgs, error } = await admin
    .from("messages")
    .select("id, created_at, direction, body, status, contact_id, conversation_id, external_id, metadata")
    .eq("direction", "inbound")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  const contactIds = Array.from(new Set((msgs ?? []).map((m) => m.contact_id).filter(Boolean)));
  let contactById = new Map();
  let leadByContactId = new Map();
  if (contactIds.length > 0) {
    const { data: contacts } = await admin.from("contacts").select("id, phone_number, display_name, push_name").in("id", contactIds);
    for (const c of contacts ?? []) contactById.set(c.id, c);
    const { data: leads } = await admin.from("crm_leads").select("id, title, contact_id, custom_fields").in("contact_id", contactIds);
    for (const l of leads ?? []) leadByContactId.set(l.contact_id, l);
  }
  const out = (msgs ?? []).map((m) => {
    const c = contactById.get(m.contact_id);
    const l = m.contact_id ? leadByContactId.get(m.contact_id) : undefined;
    const cf = (l?.custom_fields ?? {}) as Record<string, unknown>;
    return {
      at: m.created_at,
      contact_name: c?.push_name || c?.display_name || null,
      contact_phone: c?.phone_number || null,
      lead_id: l?.id ?? null,
      lead_title: l?.title ?? null,
      direction: m.direction,
      body: m.body,
      status: m.status,
      external_id: m.external_id,
      metadata: m.metadata,
      prospecting_status: typeof cf.prospecting_status === "string" ? cf.prospecting_status : null,
    };
  });
  return ok({ count: out.length, since, messages: out }, { requestId });
}

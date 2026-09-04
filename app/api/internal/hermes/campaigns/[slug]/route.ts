/**
 * GET /api/internal/hermes/campaigns/[slug]
 *
 * Retorna stats de uma campanha para o Hermes (operador comercial B2B).
 * Filtra a fila `prospecting_outbound_queue` por `metadata->>campaign = slug`
 * e agrega contadores para a visão de pipeline.
 *
 * Auth: bearer `HERMES_API_TOKEN` (env em Production). Timing-safe.
 *
 * NÃO toca food_commerce_settings (essa org não os tem ativos).
 * NÃO cria fila, NÃO envia nada. Apenas LÊ.
 *
 * Resposta 200:
 *   { data: {
 *       campaign, totals: {pending, sent, ...}, leads: [{leadId, status, ...}]
 *   } }
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteCtx {
  params: Promise<{ slug: string }>;
}

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

interface QueueRow {
  id: string;
  kind: "opening" | "followup";
  status: "pending" | "processing" | "sent" | "cancelled" | "failed";
  scheduled_for: string;
  metadata: { lead_id?: string; company?: string; campaign?: string } | null;
  lead_id: string;
}

interface LeadRow {
  id: string;
  title: string;
  source: string;
  custom_fields: { prospecting_status?: string; last_reply_at?: string | null; last_activity_at?: string | null } | null;
  contact_id: string;
  updated_at: string;
  last_activity_at: string | null;
}

interface ContactRow {
  id: string;
  phone_number: string | null;
  is_blocked: boolean;
  force_human: boolean;
  is_anonymized: boolean;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  if (!authorize(req)) {
    return fail("unauthenticated", "Bearer HERMES_API_TOKEN ausente ou inválido.", 401, { requestId });
  }
  const { slug } = await ctx.params;
  if (!slug || slug.length > 80) {
    return fail("invalid_request", "slug inválido.", 400, { requestId });
  }

  const supabase = createAdminClient();
  try {
    // 1. Fila filtrada por campaign
    const { data: queueRows, error: qErr } = await supabase
      .from("prospecting_outbound_queue")
      .select("id, kind, status, scheduled_for, metadata, lead_id")
      .eq("metadata->>campaign", slug)
      .order("scheduled_for", { ascending: true });
    if (qErr) {
      return fail("internal_error", `queue read: ${qErr.message}`, 500, { requestId });
    }
    const rows = (queueRows ?? []) as QueueRow[];

    // 2. Contadores
    const totals = {
      pending: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      replied: 0,
      held: 0,
      cancelled: 0,
      failed: 0,
      opt_out: 0,
      handoff: 0,
      followup_pending: 0,
    };
    for (const r of rows) {
      if (r.status === "pending") {
        totals.pending += 1;
        if (r.kind === "followup") totals.followup_pending += 1;
      } else if (r.status === "processing") {
        // Em processamento: conta como held
        totals.held += 1;
      } else if (r.status === "sent") {
        totals.sent += 1;
      } else if (r.status === "cancelled") {
        totals.cancelled += 1;
      } else if (r.status === "failed") {
        totals.failed += 1;
      }
    }

    // 3. Detalhe por lead (1 row por lead — abertura se houver, senão followup)
    const leadIds = Array.from(new Set(rows.map((r) => r.lead_id).filter((id): id is string => UUID_RX.test(id))));
    let leads: Array<{
      leadId: string;
      company: string;
      status: string;
      phone: string;
      prospectingStatus: string | null;
      isBlocked: boolean;
      inHandoff: boolean;
      lastActivityAt: string | null;
      lastReplyAt: string | null;
    }> = [];
    if (leadIds.length > 0) {
      const [{ data: leadRows }, { data: contactRows }] = await Promise.all([
        supabase
          .from("crm_leads")
          .select("id, title, source, custom_fields, contact_id, updated_at, last_activity_at")
          .in("id", leadIds),
        supabase
          .from("contacts")
          .select("id, phone_number, is_blocked, force_human, is_anonymized")
          .in("id", [] as string[]),
      ]);
      const contactById = new Map<string, ContactRow>();
      // O contacts.id vem separado; vamos pegar via contact_id dos leads
      const contactIds = Array.from(new Set(((leadRows ?? []) as LeadRow[]).map((l) => l.contact_id).filter(Boolean)));
      if (contactIds.length > 0) {
        const { data: cts } = await supabase
          .from("contacts")
          .select("id, phone_number, is_blocked, force_human, is_anonymized")
          .in("id", contactIds);
        for (const c of (cts ?? []) as ContactRow[]) contactById.set(c.id, c);
      }
      const leadById = new Map<string, LeadRow>();
      for (const l of (leadRows ?? []) as LeadRow[]) leadById.set(l.id, l);

      // Para cada lead, pega a row MAIS ANTIGA ainda ativa (ou a sent mais recente)
      const byLead = new Map<string, QueueRow>();
      for (const r of rows) {
        const cur = byLead.get(r.lead_id);
        if (!cur) {
          byLead.set(r.lead_id, r);
          continue;
        }
        // prioriza pending/processing > sent > cancelled/failed
        const rank = (s: QueueRow["status"]): number => {
          if (s === "pending" || s === "processing") return 0;
          if (s === "sent") return 1;
          return 2;
        };
        if (rank(r.status) < rank(cur.status)) byLead.set(r.lead_id, r);
      }

      leads = leadIds.map((id) => {
        const lead = leadById.get(id);
        const row = byLead.get(id);
        const ct = lead ? contactById.get(lead.contact_id) : undefined;
        const cf = (lead?.custom_fields ?? {}) as Record<string, unknown>;
        const lastReplyAt = typeof cf.last_reply_at === "string" ? cf.last_reply_at : null;
        const lastActivityAt = (lead?.last_activity_at as string | null) ?? null;
        return {
          leadId: id,
          company: lead?.title ?? row?.metadata?.company ?? "(sem nome)",
          status: row?.status ?? "unknown",
          phone: ct?.phone_number ?? "",
          prospectingStatus: typeof cf.prospecting_status === "string" ? cf.prospecting_status : null,
          isBlocked: Boolean(ct?.is_blocked),
          inHandoff: Boolean(ct?.force_human),
          lastActivityAt,
          lastReplyAt,
        };
      });

      // 4. opt_out e handoff derivados dos contacts do batch
      totals.opt_out = (leadRows ?? []).filter((l) => Boolean(((l.custom_fields ?? {}) as Record<string, unknown>).opt_out === true)).length;
      totals.handoff = (contactRows ?? []).filter((c) => c.force_human).length;
    }

    // 5. delivered/read não são contados na fila (não temos status pós-envio
    //    sem ler messages.outbound). Devolvemos 0 e o Hermes interpreta.
    void totals.delivered;
    void totals.read;

    return ok({ campaign: slug, totals, leads }, { requestId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("internal_error", message, 500, { requestId });
  }
}

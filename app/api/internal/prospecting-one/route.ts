/**
 * POST /api/internal/prospecting-one — TEMPORÁRIO.
 *
 * Operações one-shot para a campanha manual curada de prospecção outbound
 * (CSV). Suporta apenas `prepare` (importa UM prospect manual_curated para a
 * fila) e `send` (dispara o dispatch oficial sobre UM queueId específico).
 *
 * Auth: mesmo contrato de /api/v1/cron/prospecting-dispatch (Bearer
 * CRON_SECRET/INTERNAL_CRON_SECRET/INTERNAL_SECRET).
 *
 * REMOVER após a janela de uso.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { isAuthorizedProspectingCron } from "@/lib/prospecting/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { importProspect, targetOrganizationId } from "@/lib/prospecting/service";
import { dispatchQueueRow } from "@/lib/prospecting/dispatch";
import type { PublicBusinessProspect } from "@/lib/prospecting/google-places";
import { normalizeBrazilianCommercialPhone } from "@/lib/prospecting/normalization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface QueueRow {
  id: string;
  organization_id: string;
  lead_id: string;
  contact_id: string;
  conversation_id: string;
  channel_session_id: string;
  kind: "opening" | "followup";
  message_body: string;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
  crm_message_id: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
}

const TARGET_COMPANY = "Casa Faísca";

// CSV line embedded para que o deploy não dependa do arquivo em Data/
// (que está fora do source git). Casa Faísca é a primeira entrada do CSV
// Data/GB_Prospeccao_Foodservice_50_Leads_SJC_Jacarei.csv (linha 2).
const CASA_FAISCA_CSV_LINE = [
  "Casa Faísca",
  "São José dos Campos",
  "Pizzaria",
  "A",
  "(12) 98823-3552",
  "Confirmado",
  "Praça Pedro Américo, 28 - Vila Ema",
  "https://acasafaisca.com.br/",
  "Reservas por WhatsApp + delivery próprio",
  "Pendente",
  "Novo — não contatado",
  "Validar no CRM e abordar",
  "https://acasafaisca.com.br/",
  "2026-09-03 00:00:00",
] as const;

function buildCasaFaiscaProspect(): PublicBusinessProspect {
  const phoneRaw = CASA_FAISCA_CSV_LINE[4];
  const normalized = normalizeBrazilianCommercialPhone(phoneRaw) ?? phoneRaw;
  const sourceId = `casa-faisca::${normalized}`;
  return {
    source: "manual_curated",
    sourceId,
    sourceUrl: CASA_FAISCA_CSV_LINE[12] || null,
    placeId: sourceId,
    companyName: TARGET_COMPANY,
    category: "pizzaria",
    phoneRaw,
    website: CASA_FAISCA_CSV_LINE[7] || null,
    address: CASA_FAISCA_CSV_LINE[6],
    neighborhood: "Vila Ema",
    city: "São José dos Campos",
    state: "SP",
    mapsUrl: null,
    rating: null,
    reviewCount: null,
    businessStatus: "OPERATIONAL",
    primaryType: "pizzaria",
    types: ["pizzaria"],
  };
}

function maskPhone(e164: string | null): string {
  if (!e164) return "";
  const digits = e164.replace(/\D/g, "");
  if (digits.length < 8) return e164;
  return `+${digits.slice(0, 3)} (${digits.slice(3, 5)}) *****-${digits.slice(-2)}`;
}

interface PrepareBody { action: "prepare" }
interface SendBody { action: "send"; queueId: string }
type Body = PrepareBody | SendBody | Record<string, never>;

function asBody(raw: unknown): Body {
  if (raw && typeof raw === "object") return raw as Body;
  return {};
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  if (!isAuthorizedProspectingCron(req)) {
    return NextResponse.json(
      { error: { code: "forbidden", message: "Cron secret missing or invalid." } },
      { status: 403, headers: { "x-request-id": requestId } },
    );
  }

  let body: Body = {};
  if (req.method === "POST") {
    try {
      const text = await req.text();
      if (text) body = asBody(JSON.parse(text));
    } catch {
      return NextResponse.json({ error: { code: "invalid_body" } }, { status: 400, headers: { "x-request-id": requestId } });
    }
  }

  const action = (body as { action?: string }).action;

  if (action === "prepare") {
    try {
      const db = createAdminClient() as unknown as SupabaseClient;
      const organizationId = await targetOrganizationId(db);
      const prospect = buildCasaFaiscaProspect();
      const outcome = await importProspect(db, prospect);
      if (!outcome.leadId) {
        return NextResponse.json(
          { error: { code: "import_failed", message: "importProspect não retornou leadId", outcome } },
          { status: 500, headers: { "x-request-id": requestId } },
        );
      }
      const { data: rows, error: rowsErr } = await db
        .from("prospecting_outbound_queue")
        .select("id, kind, status, scheduled_for, lead_id, contact_id, conversation_id, channel_session_id, message_body, idempotency_key, metadata, organization_id, attempts, max_attempts, crm_message_id, created_at")
        .eq("organization_id", organizationId)
        .eq("lead_id", outcome.leadId)
        .order("created_at", { ascending: true });
      if (rowsErr) {
        return NextResponse.json(
          { error: { code: "queue_lookup", message: rowsErr.message } },
          { status: 500, headers: { "x-request-id": requestId } },
        );
      }
      const queueRow = (rows ?? []).find((r) => {
        const md = (r as { metadata?: { company?: string } | null }).metadata;
        return md?.company === TARGET_COMPANY && (r as { kind?: string }).kind === "opening";
      }) ?? (rows ?? [])[0];
      if (!queueRow) {
        return NextResponse.json(
          { error: { code: "queue_row_missing", message: "Nenhuma fila encontrada para o lead criado." } },
          { status: 500, headers: { "x-request-id": requestId } },
        );
      }
      const qr = queueRow as {
        id: string;
        kind: string;
        status: string;
        lead_id: string;
        metadata?: { company?: string } | null;
        message_body: string;
      };
      if (qr.metadata?.company !== TARGET_COMPANY) {
        return NextResponse.json(
          { error: { code: "company_mismatch", message: "Queue encontrada não é da Casa Faísca." } },
          { status: 500, headers: { "x-request-id": requestId } },
        );
      }
      const { data: contact } = await db
        .from("contacts")
        .select("phone_number")
        .eq("id", (queueRow as { contact_id: string }).contact_id)
        .maybeSingle();
      const phone = (contact as { phone_number?: string } | null)?.phone_number ?? null;
      return NextResponse.json(
        {
          data: {
            company: TARGET_COMPANY,
            leadId: qr.lead_id,
            queueId: qr.id,
            status: qr.status,
            kind: qr.kind,
            message_body: qr.message_body,
            phone_masked: maskPhone(phone),
            idempotency_key: (queueRow as { idempotency_key?: string }).idempotency_key,
            outcome_import: outcome,
            note: "Nenhuma mensagem foi enviada. Use action=send para despachar.",
          },
        },
        { headers: { "x-request-id": requestId } },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { error: { code: "prepare_throw", message } },
        { status: 500, headers: { "x-request-id": requestId } },
      );
    }
  }

  if (action === "send") {
    const sb = body as SendBody;
    if (typeof sb.queueId !== "string" || !sb.queueId) {
      return NextResponse.json({ error: { code: "queue_id_required" } }, { status: 400, headers: { "x-request-id": requestId } });
    }
    try {
      const db = createAdminClient() as unknown as SupabaseClient;
      const organizationId = await targetOrganizationId(db);
      const { data: rowData, error: rowErr } = await db
        .from("prospecting_outbound_queue")
        .select("id, kind, status, scheduled_for, lead_id, contact_id, conversation_id, channel_session_id, message_body, idempotency_key, attempts, max_attempts, crm_message_id, created_at, organization_id, metadata")
        .eq("id", sb.queueId)
        .maybeSingle();
      if (rowErr) {
        return NextResponse.json({ error: { code: "row_lookup", message: rowErr.message } }, { status: 500, headers: { "x-request-id": requestId } });
      }
      if (!rowData) {
        return NextResponse.json({ error: { code: "row_not_found" } }, { status: 404, headers: { "x-request-id": requestId } });
      }
      const r = rowData as QueueRow;
      if (r.organization_id !== organizationId) {
        return NextResponse.json({ error: { code: "wrong_tenant" } }, { status: 404, headers: { "x-request-id": requestId } });
      }
      const md = (r.metadata ?? {}) as { company?: string };
      if (md.company !== TARGET_COMPANY) {
        return NextResponse.json(
          { error: { code: "company_mismatch", message: `Row ${r.id} não é da ${TARGET_COMPANY}.`, stored_company: md.company ?? null } },
          { status: 409, headers: { "x-request-id": requestId } },
        );
      }
      const result = await dispatchQueueRow(db, r);
      const { data: after } = await db
        .from("prospecting_outbound_queue")
        .select("id, status, sent_at, crm_message_id, error_code, error_message")
        .eq("id", sb.queueId)
        .maybeSingle();
      return NextResponse.json(
        { data: { dispatch: result, queue_after: after } },
        { headers: { "x-request-id": requestId } },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { error: { code: "send_throw", message } },
        { status: 500, headers: { "x-request-id": requestId } },
      );
    }
  }

  return NextResponse.json(
    { error: { code: "invalid_action", allowed: ["prepare", "send"] } },
    { status: 400, headers: { "x-request-id": requestId } },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

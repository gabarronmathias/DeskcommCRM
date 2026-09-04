/**
 * POST /api/internal/hermes/prospects/[leadId]/archive
 *
 * Operação ADMINISTRATIVA one-shot. Usada pelo Hermes para arquivar
 * prospect cujo telefone é placeholder/sintético e portanto INACEITÁVEL
 * como lead comercial válido.
 *
 * Comportamento:
 *   1. Marca TODAS as queue rows do lead (kind=opening ou followup) como
 *      `cancelled` com error_code=`placeholder_phone_archived`.
 *   2. Marca o lead com `prospecting_status=archived` em custom_fields.
 *   3. NÃO deleta contact/lead (mantém histórico).
 *   4. NÃO envia WAHA.
 *   5. Emite evento `prospect_archived_placeholder_phone` no event_log.
 *
 * Auth: bearer HERMES_API_TOKEN.
 *
 * Resposta 200:
 *   { data: { leadId, queueRowsCancelled, archived, event } }
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { targetOrganizationId } from "@/lib/prospecting/service";

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

export async function POST(
  req: NextRequest,
  { params }: { params: { leadId: string } },
): Promise<Response> {
  const requestId = randomUUID();
  if (!isAuthorized(req)) {
    return fail("forbidden", "HERMES_API_TOKEN ausente ou invalido.", 401, { requestId });
  }
  const leadId = params.leadId;
  if (!leadId || !/^[0-9a-f-]{32,40}$/i.test(leadId)) {
    return fail("invalid_lead_id", `leadId deve ser UUID (got: ${leadId?.length} chars)`, 400, { requestId });
  }

  const admin = createAdminClient();
  const organizationId = await targetOrganizationId(admin);

  // 1) Cancelar todas as queue rows do lead (apenas as pending/queued —
  //    NÃO tocar em sent/delivered para preservar histórico)
  const { data: cancelResult, error: cancelErr } = await admin
    .from("prospecting_outbound_queue")
    .update({
      status: "cancelled",
      error_code: "placeholder_phone_archived",
      error_message: "Telefone placeholder/sintetico. Lead arquivado pelo Hermes. Substituir por prospect real.",
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .in("status", ["pending", "held", "queued"])
    .select("id, kind, status");
  if (cancelErr) {
    return fail("queue_cancel_failed", cancelErr.message, 500, { requestId });
  }
  const queueRowsCancelled = cancelResult?.length ?? 0;

  // 2) Marcar lead como archived
  const { data: leadRow, error: leadErr } = await admin
    .from("crm_leads")
    .select("id, custom_fields")
    .eq("organization_id", organizationId)
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) {
    return fail("lead_read_failed", leadErr.message, 500, { requestId });
  }
  if (!leadRow) {
    return fail("lead_not_found", `lead ${leadId} nao encontrado`, 404, { requestId });
  }
  const cf = (leadRow.custom_fields ?? {}) as Record<string, unknown>;
  const newCf = {
    ...cf,
    prospecting_status: "archived",
    archived_at: new Date().toISOString(),
    archive_reason: "placeholder_phone",
  };
  const { error: leadUpdErr } = await admin
    .from("crm_leads")
    .update({ custom_fields: newCf, updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", leadId);
  if (leadUpdErr) {
    return fail("lead_update_failed", leadUpdErr.message, 500, { requestId });
  }

  // 3) Audit log
  const { data: evt } = await admin.rpc("emit_event" as never, {
    p_event_type: "prospect_archived_placeholder_phone",
    p_entity_kind: "crm_leads",
    p_entity_id: leadId,
    p_payload: {
      reason: "placeholder_phone",
      queue_rows_cancelled: queueRowsCancelled,
      organization_id: organizationId,
    },
    p_metadata: { severity: "info", request_id: requestId },
    p_organization_id: organizationId,
  } as never);

  return ok(
    {
      leadId,
      queueRowsCancelled,
      archived: true,
      event: evt ?? null,
    },
    { requestId },
  );
}

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { getWahaClient } from "@/lib/waha/client";

import { FOLLOWUP_FLOW_NAME, FOLLOWUP_MESSAGE, SARAH_STAGE_NAME } from "./config";

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

export interface DispatchResult {
  queueId: string;
  outcome: "sent" | "held" | "cancelled" | "failed";
  messageId?: string;
  reason?: string;
}

export function contactIdentityFromPhoneCheck(
  result: { numberExists: boolean; chatId: string | null; pn: string | null },
  fallbackPhone: string,
): { phoneNumber: string; waLid: string | null } | null {
  if (!result.numberExists) return null;
  const fallbackDigits = fallbackPhone.replace(/\D/g, "");
  const pnDigits = (result.pn ?? "").split("@")[0]?.replace(/\D/g, "") ?? "";
  const chatPhoneDigits = result.chatId?.endsWith("@c.us")
    ? result.chatId.slice(0, -5).replace(/\D/g, "")
    : "";
  const phoneDigits =
    pnDigits.length >= 8
      ? pnDigits
      : chatPhoneDigits.length >= 8
        ? chatPhoneDigits
        : fallbackDigits;
  if (phoneDigits.length < 8) return null;
  const waLid = result.chatId?.endsWith("@lid")
    ? result.chatId.slice(0, -4).replace(/\D/g, "") || null
    : null;
  return { phoneNumber: `+${phoneDigits}`, waLid };
}

export function contactSourceMetadataWithWaLid(
  current: unknown,
  waLid: string | null,
): Record<string, unknown> {
  const next = { ...((current ?? {}) as Record<string, unknown>) };
  if (waLid) next.waha_lid = `${waLid}@lid`;
  else delete next.waha_lid;
  return next;
}

async function recordPhoneVerification(
  db: SupabaseClient,
  row: QueueRow,
  status: "verified" | "not_whatsapp" | "check_failed",
) {
  const { data: lead } = await db
    .from("crm_leads")
    .select("custom_fields")
    .eq("organization_id", row.organization_id)
    .eq("id", row.lead_id)
    .maybeSingle();
  const current = (lead?.custom_fields ?? {}) as Record<string, unknown>;
  await db
    .from("crm_leads")
    .update({
      custom_fields: {
        ...current,
        phone_verification_status: status,
        whatsapp_verified_at: status === "verified" ? new Date().toISOString() : null,
      },
    })
    .eq("organization_id", row.organization_id)
    .eq("id", row.lead_id);
}

async function patchQueue(db: SupabaseClient, row: QueueRow, patch: Record<string, unknown>) {
  const { error } = await db
    .from("prospecting_outbound_queue")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("organization_id", row.organization_id)
    .eq("id", row.id);
  if (error) throw new Error(`prospecting_queue_update: ${error.message}`);
}

async function cancel(db: SupabaseClient, row: QueueRow, reason: string): Promise<DispatchResult> {
  await patchQueue(db, row, { status: "cancelled", error_code: reason, error_message: null });
  return { queueId: row.id, outcome: "cancelled", reason };
}

async function hold(db: SupabaseClient, row: QueueRow, reason: string): Promise<DispatchResult> {
  await patchQueue(db, row, {
    status: "pending",
    claimed_at: null,
    scheduled_for: new Date(Date.now() + 5 * 60_000).toISOString(),
    error_code: reason,
    error_message: null,
  });
  return { queueId: row.id, outcome: "held", reason };
}

async function reconcileExisting(db: SupabaseClient, row: QueueRow) {
  const { data } = await db
    .from("messages")
    .select("id, status, error_code")
    .eq("organization_id", row.organization_id)
    .contains("metadata", { idempotency_key: row.idempotency_key })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function onSent(
  db: SupabaseClient,
  row: QueueRow,
  messageId: string,
): Promise<DispatchResult> {
  const now = new Date();
  await patchQueue(db, row, {
    status: "sent",
    sent_at: now.toISOString(),
    crm_message_id: messageId,
    error_code: null,
    error_message: null,
  });

  const { data: lead } = await db
    .from("crm_leads")
    .select("custom_fields")
    .eq("organization_id", row.organization_id)
    .eq("id", row.lead_id)
    .maybeSingle();
  const current = (lead?.custom_fields ?? {}) as Record<string, unknown>;
  const fields = {
    ...current,
    prospecting_status: row.kind === "opening" ? "contacted" : "followup_sent",
    ...(row.kind === "opening" && !current.first_outbound_at
      ? { first_outbound_at: now.toISOString() }
      : {}),
    last_outbound_at: now.toISOString(),
    next_followup_at:
      row.kind === "opening" ? new Date(now.getTime() + 48 * 60 * 60_000).toISOString() : null,
  };
  await db
    .from("crm_leads")
    .update({ custom_fields: fields, last_activity_at: now.toISOString() })
    .eq("organization_id", row.organization_id)
    .eq("id", row.lead_id);

  if (row.kind === "opening") {
    const { data: pipelineRef } = await db
      .from("crm_leads")
      .select("pipeline_id")
      .eq("organization_id", row.organization_id)
      .eq("id", row.lead_id)
      .maybeSingle();
    if (pipelineRef) {
      const { data: stage } = await db
        .from("crm_stages")
        .select("id")
        .eq("organization_id", row.organization_id)
        .eq("pipeline_id", pipelineRef.pipeline_id)
        .eq("name", SARAH_STAGE_NAME)
        .eq("is_archived", false)
        .maybeSingle();
      if (stage) {
        await db
          .from("crm_leads")
          .update({ stage_id: stage.id, updated_at: now.toISOString() })
          .eq("organization_id", row.organization_id)
          .eq("id", row.lead_id);
      }
    }

    await db.from("prospecting_outbound_queue").upsert(
      {
        organization_id: row.organization_id,
        lead_id: row.lead_id,
        contact_id: row.contact_id,
        conversation_id: row.conversation_id,
        channel_session_id: row.channel_session_id,
        kind: "followup",
        flow_name: FOLLOWUP_FLOW_NAME,
        message_body: FOLLOWUP_MESSAGE,
        scheduled_for: new Date(now.getTime() + 48 * 60 * 60_000).toISOString(),
        idempotency_key: `followup48h:${row.idempotency_key}`,
        metadata: { source_queue_id: row.id, cadence: "D0_D2_STOP" },
      },
      { onConflict: "organization_id,idempotency_key", ignoreDuplicates: true },
    );
  }
  return { queueId: row.id, outcome: "sent", messageId };
}

export async function dispatchQueueRow(db: SupabaseClient, row: QueueRow): Promise<DispatchResult> {
  const [{ data: contact }, { data: conversation }, { data: session }] = await Promise.all([
    db
      .from("contacts")
      .select("phone_number, is_blocked, force_human, tags, source_metadata")
      .eq("organization_id", row.organization_id)
      .eq("id", row.contact_id)
      .maybeSingle(),
    db
      .from("conversations")
      .select("assigned_to_user_id, last_inbound_at, bot_silenced_until")
      .eq("organization_id", row.organization_id)
      .eq("id", row.conversation_id)
      .maybeSingle(),
    db
      .from("channel_sessions")
      .select("status, provider, waha_session_name")
      .eq("organization_id", row.organization_id)
      .eq("id", row.channel_session_id)
      .maybeSingle(),
  ]);
  if (!contact || !conversation || !session) return cancel(db, row, "tenant_resource_missing");
  if (contact.is_blocked || (contact.tags ?? []).includes("nao-contatar"))
    return cancel(db, row, "opt_out");
  if (contact.force_human || conversation.assigned_to_user_id || conversation.bot_silenced_until)
    return cancel(db, row, "human_takeover");
  if (row.kind === "followup" && conversation.last_inbound_at) return cancel(db, row, "replied");
  if (session.status !== "WORKING") return hold(db, row, "channel_session_not_working");

  const existing = await reconcileExisting(db, row);
  if (existing?.status === "sent") return onSent(db, row, existing.id);
  if (existing?.status === "queued" || existing?.status === "sending")
    return hold(db, row, "message_still_queued");
  if (existing?.status === "failed" && row.attempts >= row.max_attempts) {
    await patchQueue(db, row, {
      status: "failed",
      error_code: existing.error_code ?? "message_failed",
    });
    return { queueId: row.id, outcome: "failed", reason: existing.error_code ?? "message_failed" };
  }

  if (row.kind === "opening" && session.provider === "waha") {
    if (!contact.phone_number || !session.waha_session_name)
      return cancel(db, row, "phone_or_session_missing");
    const waha = getWahaClient();
    if (!waha) return hold(db, row, "waha_not_configured");
    try {
      const checked = await waha.checkPhoneExists(session.waha_session_name, contact.phone_number);
      const identity = contactIdentityFromPhoneCheck(checked, contact.phone_number);
      if (!identity) {
        await recordPhoneVerification(db, row, "not_whatsapp");
        return cancel(db, row, "not_whatsapp");
      }
      const { error: identityError } = await db
        .from("contacts")
        .update({
          phone_number: identity.phoneNumber,
          source_metadata: contactSourceMetadataWithWaLid(
            contact.source_metadata,
            identity.waLid,
          ),
          phone_lookup_at: new Date().toISOString(),
        })
        .eq("organization_id", row.organization_id)
        .eq("id", row.contact_id);
      if (identityError)
        throw new Error(`prospecting_phone_identity_update: ${identityError.message}`);
      await recordPhoneVerification(db, row, "verified");
    } catch {
      await recordPhoneVerification(db, row, "check_failed");
      return hold(db, row, "waha_phone_check_failed");
    }
  }

  try {
    const message = await sendMessageHandler(
      db,
      {
        organization_id: row.organization_id,
        actor: { type: "ai_agent", id: "sarah-prospecting", role: "manager" },
        requestId: row.idempotency_key,
      },
      {
        conversation_id: row.conversation_id,
        type: "text",
        body: row.message_body,
        metadata: {
          idempotency_key: row.idempotency_key,
          source: typeof row.metadata?.source === "string" ? row.metadata.source : "prospecting",
          prospecting: true,
          cadence: row.kind === "opening" ? "D0" : "D+2",
        },
      },
    );
    if (message.status === "sent") return onSent(db, row, message.id);
    if (message.status === "failed") {
      await patchQueue(db, row, {
        status: "failed",
        crm_message_id: message.id,
        error_code: message.error_code ?? "message_failed",
        error_message: message.error_message?.slice(0, 240) ?? null,
      });
      return {
        queueId: row.id,
        outcome: "failed",
        messageId: message.id,
        reason: message.error_code ?? "message_failed",
      };
    }
    await patchQueue(db, row, {
      status: "pending",
      claimed_at: null,
      crm_message_id: message.id,
      scheduled_for: new Date(Date.now() + 5 * 60_000).toISOString(),
      error_code: "message_queued",
    });
    return { queueId: row.id, outcome: "held", messageId: message.id, reason: "message_queued" };
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return cancel(db, row, "opt_out");
    const detail = error instanceof Error ? error.message.slice(0, 240) : "unknown";
    if (row.attempts >= row.max_attempts) {
      await patchQueue(db, row, {
        status: "failed",
        error_code: "dispatch_error",
        error_message: detail,
      });
      return { queueId: row.id, outcome: "failed", reason: "dispatch_error" };
    }
    return hold(db, row, "dispatch_error");
  }
}

export async function claimOne(
  db: SupabaseClient,
  organizationId: string,
): Promise<QueueRow | null> {
  const { data, error } = await db.rpc("fn_claim_prospecting_outbound", {
    p_org: organizationId,
    p_limit: 1,
  });
  if (error) throw new Error(`prospecting_claim: ${error.message}`);
  return ((data ?? [])[0] as QueueRow | undefined) ?? null;
}

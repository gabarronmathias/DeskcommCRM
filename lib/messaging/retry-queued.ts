/**
 * Reenvio idempotente de uma mensagem que nem chegou ao transporte.
 *
 * A linha é "claimed" como `sending` antes da chamada ao adapter. Assim dois
 * webhooks/operadores não conseguem enviar duas vezes a mesma mensagem queued.
 * Este módulo não cria uma nova mensagem: preserva a mesma linha, histórico e
 * intenção original do operador.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CHANNEL_SESSION_REF_COLUMNS,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";

type SB = SupabaseClient;

type ConversationForRetry = {
  id: string;
  organization_id: string;
  is_group: boolean;
  group_chat_id: string | null;
  provider_conversation_id: string | null;
  contacts: {
    phone_number: string | null;
    wa_identity: string | null;
    wa_lid: string | null;
    is_blocked: boolean;
  } | null;
  channel_sessions: (ChannelSessionRef & { status: string; archived_at?: string | null }) | null;
};

export type RetryQueuedResult =
  | { outcome: "sent"; messageId: string }
  | { outcome: "not_queued" | "not_sendable" | "not_found"; messageId: string | null; reason: string };

/**
 * Reenvia uma única mensagem textual presa em `queued`.
 *
 * Não usamos `sendMessageHandler`: ele cria uma linha nova, o que duplicaria o
 * texto que o operador já aprovou. A transição queued -> sending é o claim
 * atômico que protege contra duas tentativas concorrentes.
 */
export async function retryQueuedTextMessage(
  supabase: SB,
  input: { organizationId: string; messageId: string; source: "operator" | "session_recovered" },
): Promise<RetryQueuedResult> {
  const { data: existing } = await supabase
    .from("messages")
    .select("id, conversation_id, body, type, status, metadata")
    .eq("organization_id", input.organizationId)
    .eq("id", input.messageId)
    .maybeSingle();

  if (!existing) return { outcome: "not_found", messageId: null, reason: "message_not_found" };
  if (existing.status !== "queued") {
    return { outcome: "not_queued", messageId: existing.id, reason: "message_is_not_queued" };
  }
  if (existing.type !== "text" || !existing.body) {
    return { outcome: "not_sendable", messageId: existing.id, reason: "only_text_messages_are_retried" };
  }

  // Claim antes de resolver/enviar. O WHERE no estado esperado é a barreira
  // contra dois cliques, dois webhooks WORKING, ou um worker atrasado.
  const { data: claimed } = await supabase
    .from("messages")
    .update({ status: "sending", error_code: null, error_message: null })
    .eq("organization_id", input.organizationId)
    .eq("id", existing.id)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (!claimed) {
    return { outcome: "not_queued", messageId: existing.id, reason: "message_claimed_elsewhere" };
  }

  const select = `id, organization_id, is_group, group_chat_id, provider_conversation_id, contacts:contact_id(phone_number, wa_identity, wa_lid, is_blocked), channel_sessions:channel_session_id(${CHANNEL_SESSION_REF_COLUMNS}, status, archived_at)`;
  const { data: rawConversation } = await supabase
    .from("conversations")
    .select(select)
    .eq("organization_id", input.organizationId)
    .eq("id", existing.conversation_id)
    .maybeSingle();
  const conversation = rawConversation as unknown as ConversationForRetry | null;

  const originalMetadata =
    existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {};
  const requeue = async (reason: string) => {
    await supabase
      .from("messages")
      .update({
        status: "queued",
        metadata: {
          ...originalMetadata,
          queued_reason: reason,
          last_retry_source: input.source,
          last_retry_at: new Date().toISOString(),
        },
      })
      .eq("organization_id", input.organizationId)
      .eq("id", existing.id)
      .eq("status", "sending");
  };

  if (!conversation || conversation.contacts?.is_blocked || !conversation.channel_sessions) {
    await requeue("retry_missing_conversation_or_contact");
    return { outcome: "not_sendable", messageId: existing.id, reason: "conversation_or_contact_unavailable" };
  }
  if (conversation.channel_sessions.archived_at || conversation.channel_sessions.status !== "WORKING") {
    await requeue("channel_session_not_working");
    return { outcome: "not_sendable", messageId: existing.id, reason: "channel_session_not_working" };
  }

  const adapter = getAdapter(conversation.channel_sessions.provider);
  const recipient = adapter.resolveRecipient({
    isGroup: conversation.is_group,
    groupChatId: conversation.group_chat_id,
    phoneNumber: conversation.contacts.phone_number,
    waIdentity: conversation.contacts.wa_identity,
    waLid: conversation.contacts.wa_lid,
  });
  if (!adapter.isConfigured() || !recipient) {
    await requeue(!recipient ? "missing_phone_number" : adapter.codes.notConfigured);
    return { outcome: "not_sendable", messageId: existing.id, reason: !recipient ? "missing_phone_number" : adapter.codes.notConfigured };
  }

  try {
    const { externalId } = await adapter.send({
      sessionRef: resolveSessionRef(conversation.channel_sessions),
      to: recipient,
      providerConversationId: conversation.provider_conversation_id,
      kind: "text",
      body: existing.body,
    });
    await supabase
      .from("messages")
      .update({
        status: "sent",
        external_id: externalId,
        ack: 0,
        metadata: { ...originalMetadata, redrive: input.source, redriven_at: new Date().toISOString() },
      })
      .eq("organization_id", input.organizationId)
      .eq("id", existing.id)
      .eq("status", "sending");
    return { outcome: "sent", messageId: existing.id };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 280) : "send_failed";
    await requeue("retry_transport_error");
    console.warn("[messaging.retry-queued] transport retry failed", { messageId: existing.id, source: input.source, message });
    return { outcome: "not_sendable", messageId: existing.id, reason: "retry_transport_error" };
  }
}

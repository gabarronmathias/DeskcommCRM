import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";

export const dynamic = "force-dynamic";

type FoodStatus =
  | "new"
  | "accepted"
  | "preparing"
  | "ready"
  | "out_for_delivery"
  | "completed"
  | "cancelled";

const TRANSITIONS: Record<FoodStatus, FoodStatus[]> = {
  new: ["accepted", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["out_for_delivery", "completed", "cancelled"],
  out_for_delivery: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

const VALID_STATUSES = new Set<FoodStatus>([
  "new",
  "accepted",
  "preparing",
  "ready",
  "out_for_delivery",
  "completed",
  "cancelled",
]);

function notificationText(
  status: FoodStatus,
  fulfillment: string | undefined,
): string | null {
  if (status === "accepted") {
    return "✅ Pedido confirmado! Recebemos seu pedido e já vamos cuidar dele. Você receberá as próximas atualizações por aqui.";
  }

  if (status === "ready") {
    return fulfillment === "entrega"
      ? "✅ Seu pedido está pronto e será enviado para entrega em breve."
      : "✅ Seu pedido está pronto para retirada. Pode vir buscar! 🍽️";
  }

  if (status === "out_for_delivery") {
    return "🛵 Seu pedido saiu para entrega! Em breve ele chega até você.";
  }

  if (status === "completed") {
    return "✅ Pedido concluído. Obrigado pela preferência! 💚";
  }

  if (status === "cancelled") {
    return "⚠️ Seu pedido foi cancelado. Se precisar de ajuda, responda esta mensagem e fale com a nossa equipe.";
  }

  return null;
}

async function sendOrderStatusNotification(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  organizationId: string;
  orderId: string;
  contactId: string | null;
  status: FoodStatus;
  fulfillment?: string;
  requestId: string;
}) {
  const {
    supabase,
    organizationId,
    orderId,
    contactId,
    status,
    fulfillment,
    requestId,
  } = params;

  const body = notificationText(status, fulfillment);

  if (!body) {
    return {
      attempted: false,
      reason: "status_without_notification",
    };
  }

  if (!contactId) {
    return {
      attempted: false,
      reason: "order_without_contact",
    };
  }

  try {
    const { data: session, error: sessionError } = await supabase
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("status", "WORKING")
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessionError) throw sessionError;

    if (!session) {
      return {
        attempted: false,
        reason: "no_working_channel",
      };
    }

    const {
      data: existingConversation,
      error: conversationError,
    } = await supabase
      .from("conversations")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .eq("channel_session_id", session.id)
      .eq("is_group", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (conversationError) throw conversationError;

    let conversationId = existingConversation?.id ?? null;

    if (!conversationId) {
      const {
        data: createdConversation,
        error: createConversationError,
      } = await supabase
        .from("conversations")
        .insert({
          organization_id: organizationId,
          contact_id: contactId,
          channel_session_id: session.id,
          channel: "whatsapp",
          status: "open",
          is_group: false,
          metadata: {
            source: "food_order_status",
            order_id: orderId,
          },
        })
        .select("id")
        .single();

      if (createConversationError) {
        throw createConversationError;
      }

      conversationId = createdConversation.id;
    }

    const message = await sendMessageHandler(
      supabase,
      {
        organization_id: organizationId,
        actor: {
          type: "webhook_source",
          id: "food-order-status",
        },
        requestId,
      },
      {
        conversation_id: conversationId,
        type: "text",
        body,
        metadata: {
          source: "food_order_status",
          order_id: orderId,
          food_status: status,
        },
      },
    );

    return {
      attempted: true,
      message_id: message.id,
      message_status: message.status,
    };
  } catch (error) {
    console.error(
      "[orders.status] falha ao enviar atualização automática pelo WhatsApp",
      error instanceof Error ? error.message : error,
    );

    return {
      attempted: true,
      reason: "notification_failed",
    };
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", {
    requestId,
    resource: "orders",
  });

  if (!authz.ok) return authz.response;

  const activeOrg = authz.org;
  const supabase = await createClient();
  const { id } = await context.params;

  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return fail(
      "validation_failed",
      "JSON inválido.",
      422,
      { requestId },
    );
  }

  const nextStatus =
    typeof body === "object" &&
    body !== null &&
    "status" in body &&
    typeof (body as { status?: unknown }).status === "string"
      ? (body as { status: string }).status
      : null;

  if (
    !nextStatus ||
    !VALID_STATUSES.has(nextStatus as FoodStatus)
  ) {
    return fail(
      "validation_failed",
      "Status de pedido inválido.",
      422,
      { requestId },
    );
  }

  const { data: order, error: orderError } =
    await supabase
      .from("orders")
      .select(`
        id,
        organization_id,
        external_provider,
        external_id,
        contact_id,
        status,
        food_status,
        payload
      `)
      .eq("id", id)
      .eq("organization_id", activeOrg.orgId)
      .eq("external_provider", "deskcomm_food")
      .maybeSingle();

  if (orderError) {
    return fail(
      "internal_error",
      "Não foi possível consultar o pedido.",
      500,
      {
        details: {
          message: orderError.message,
        },
        requestId,
      },
    );
  }

  if (!order) {
    return fail(
      "not_found",
      "Pedido não encontrado.",
      404,
      { requestId },
    );
  }

  const currentStatus =
    (order.food_status ?? "new") as FoodStatus;

  const targetStatus =
    nextStatus as FoodStatus;

  if (currentStatus === targetStatus) {
    return ok(order, { requestId });
  }

  if (
    !TRANSITIONS[currentStatus]?.includes(targetStatus)
  ) {
    return fail(
      "validation_failed",
      `Transição inválida: ${currentStatus} → ${targetStatus}.`,
      422,
      { requestId },
    );
  }

  const genericStatus =
    targetStatus === "cancelled"
      ? "cancelled"
      : targetStatus === "completed"
        ? "fulfilled"
        : order.status;

  const {
    data: updated,
    error: updateError,
  } = await supabase
    .from("orders")
    .update({
      food_status: targetStatus,
      status: genericStatus,
    })
    .eq("id", order.id)
    .eq("organization_id", activeOrg.orgId)
    .select(`
      id,
      external_id,
      status,
      food_status,
      food_status_updated_at,
      total_cents,
      currency,
      payment_method,
      payload,
      ordered_at
    `)
    .single();

  if (updateError) {
    return fail(
      "internal_error",
      "Não foi possível atualizar o pedido.",
      500,
      {
        details: {
          message: updateError.message,
        },
        requestId,
      },
    );
  }

  const notification =
    await sendOrderStatusNotification({
      supabase,
      organizationId: activeOrg.orgId,
      orderId: order.id,
      contactId: order.contact_id,
      status: targetStatus,
      fulfillment:
        typeof order.payload === "object" &&
        order.payload !== null
          ? (
              order.payload as {
                fulfillment?: string;
              }
            ).fulfillment
          : undefined,
      requestId,
    });

  return ok(
    {
      ...updated,
      whatsapp_notification: notification,
    },
    { requestId },
  );
}

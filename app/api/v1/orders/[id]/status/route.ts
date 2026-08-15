import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

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
    return fail("validation_failed", "JSON inválido.", 422, {
      requestId,
    });
  }

  const nextStatus =
    typeof body === "object" &&
    body !== null &&
    "status" in body &&
    typeof (body as { status?: unknown }).status === "string"
      ? (body as { status: string }).status
      : null;

  if (!nextStatus || !VALID_STATUSES.has(nextStatus as FoodStatus)) {
    return fail(
      "validation_failed",
      "Status de pedido inválido.",
      422,
      { requestId },
    );
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, organization_id, external_provider, status, food_status, payload")
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
        details: { message: orderError.message },
        requestId,
      },
    );
  }

  if (!order) {
    return fail("not_found", "Pedido não encontrado.", 404, {
      requestId,
    });
  }

  const currentStatus = (order.food_status ?? "new") as FoodStatus;
  const targetStatus = nextStatus as FoodStatus;

  if (currentStatus === targetStatus) {
    return ok(order, { requestId });
  }

  if (!TRANSITIONS[currentStatus]?.includes(targetStatus)) {
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

  const { data: updated, error: updateError } = await supabase
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
        details: { message: updateError.message },
        requestId,
      },
    );
  }

  return ok(updated, { requestId });
}

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;

  if (!activeOrg) {
    return fail(
      "organization_required",
      "Organização ativa não encontrada.",
      403,
      { requestId },
    );
  }

  const url = new URL(req.url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? "100");

  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
    : 100;

  const { data, error } = await supabase
    .from("orders")
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
      ordered_at,
      contact_id,
      contacts (
        id,
        name,
        display_name,
        phone_number
      ),
      food_order_items (
        id,
        product_id,
        product_name_snapshot,
        unit_price_cents,
        quantity,
        line_total_cents,
        selected_modifiers,
        added_via_recommendation,
        recommendation_rule_id
      )
    `)
    .eq("organization_id", activeOrg.orgId)
    .eq("external_provider", "deskcomm_food")
    .order("ordered_at", { ascending: false })
    .limit(limit);

  if (error) {
    return fail(
      "internal_error",
      "Não foi possível carregar os pedidos.",
      500,
      {
        details: { message: error.message },
        requestId,
      },
    );
  }

  return ok(data ?? [], { requestId });
}

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", "Período inválido.", 422, {
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }

  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  if (from.getTime() >= to.getTime()) {
    return fail("validation_failed", "'from' deve ser anterior a 'to'.", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_food_delivery_report", {
    p_organization_id: authz.org.orgId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });

  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data, { requestId });
}

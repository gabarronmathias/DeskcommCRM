import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { authenticateAthosPartner } from "@/lib/athos/service";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ launch_id: string }>;
}

const launchIdSchema = z.string().uuid();

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { launch_id: rawLaunchId } = await ctx.params;
  const launchId = launchIdSchema.safeParse(rawLaunchId);
  if (!launchId.success) {
    return fail("not_found", "launch_not_found", 404, { requestId });
  }

  const auth = await authenticateAthosPartner(req.headers.get("authorization"), "athos:launch:read");
  if (!auth.ok) {
    return fail(auth.code, auth.message, auth.status, { requestId });
  }

  const admin = createAdminClient();
  const { data: launch, error } = await admin
    .from("athos_sandbox_launches")
    .select(
      "launch_id, store_ref, expires_at, crm_contact_id, crm_conversation_id, customer_display_name, customer_phone",
    )
    .eq("launch_id", launchId.data)
    .eq("connection_id", auth.connection.id)
    .eq("store_ref", auth.connection.store_ref)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !launch) {
    return fail("not_found", "launch_not_found", 404, { requestId });
  }

  return ok(
    {
      launch_id: launch.launch_id,
      store_ref: launch.store_ref,
      expires_at: launch.expires_at,
      correlation: {
        crm_contact_id: launch.crm_contact_id,
        crm_conversation_id: launch.crm_conversation_id ?? null,
      },
      customer: {
        display_name: launch.customer_display_name ?? null,
        phone: launch.customer_phone ?? null,
      },
    },
    { requestId, headers: { "Cache-Control": "no-store" } },
  );
}

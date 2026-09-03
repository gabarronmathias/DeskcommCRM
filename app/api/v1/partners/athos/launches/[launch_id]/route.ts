import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
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
    .from("partner_athos_launches")
    .select("launch_id, store_ref, expires_at, contact_id, conversation_id")
    .eq("launch_id", launchId.data)
    .eq("connection_id", auth.connection.id)
    .eq("organization_id", auth.connection.organization_id)
    .eq("store_ref", auth.connection.store_ref)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !launch) {
    return fail("not_found", "launch_not_found", 404, { requestId });
  }

  const { data: contact } = await admin
    .from("contacts")
    .select("display_name, name, phone_number")
    .eq("id", launch.contact_id)
    .eq("organization_id", auth.connection.organization_id)
    .maybeSingle();

  await audit({
    action: "athos.launch_read",
    organizationId: auth.connection.organization_id,
    resourceType: "athos_launch",
    resourceId: launch.launch_id,
    metadata: { store_ref: launch.store_ref },
  });

  return ok(
    {
      launch_id: launch.launch_id,
      store_ref: launch.store_ref,
      expires_at: launch.expires_at,
      correlation: {
        crm_contact_id: launch.contact_id,
        crm_conversation_id: launch.conversation_id ?? null,
      },
      customer: {
        display_name: contact?.display_name ?? contact?.name ?? null,
        phone: contact?.phone_number ?? null,
      },
    },
    { requestId, headers: { "Cache-Control": "no-store" } },
  );
}

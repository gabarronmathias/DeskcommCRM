import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { fail, ok } from "@/lib/api/wrappers";
import { authenticateAthosPartner } from "@/lib/athos/partner-auth";
import { McpAuthError } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ launch_id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  try {
    const { auth, admin, integration, storeRef } = await authenticateAthosPartner(
      req.headers.get("authorization"),
      "athos:launch:read",
    );
    const { launch_id: launchId } = await ctx.params;
    const { data: launch, error } = await admin
      .from("partner_launches")
      .select("id, contact_id, conversation_id, store_ref, expires_at, metadata")
      .eq("id", launchId)
      .eq("organization_id", auth.organizationId)
      .eq("provider", "athos")
      .eq("store_ref", storeRef)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error || !launch || integration.organization_id !== auth.organizationId) {
      return fail("not_found", "launch_not_found", 404, { requestId });
    }
    const { data: contact } = await admin
      .from("contacts")
      .select("name, display_name, phone_number")
      .eq("id", launch.contact_id)
      .eq("organization_id", auth.organizationId)
      .maybeSingle();

    return ok({
      launch_id: launch.id,
      store_ref: launch.store_ref,
      expires_at: launch.expires_at,
      correlation: {
        crm_contact_id: launch.contact_id,
        crm_conversation_id: launch.conversation_id,
      },
      customer: {
        display_name: contact?.display_name ?? contact?.name ?? null,
        phone: contact?.phone_number ?? null,
      },
    }, { requestId, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof McpAuthError) {
      return fail(error.httpStatus === 403 ? "forbidden_scope" : "unauthenticated", error.message, error.httpStatus, { requestId });
    }
    return fail("internal_error", "launch_lookup_failed", 500, { requestId });
  }
}

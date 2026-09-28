import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { authenticateAthosPartner } from "@/lib/athos/partner-auth";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { McpAuthError } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const testLaunchRequest = z.object({ store_ref: z.string().min(1).max(160) }).strict();
const LAUNCH_TTL_MS = 10 * 60_000;

/** Creates a sandbox-only launch without sending a WhatsApp message or creating an order. */
export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    const { auth, admin, storeRef } = await authenticateAthosPartner(
      req.headers.get("authorization"),
      "athos:events:write",
    );

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail("invalid_request", "invalid_json", 400, { requestId });
    }
    const parsed = testLaunchRequest.safeParse(body);
    if (!parsed.success) return fail("invalid_request", "invalid_test_launch_request", 400, { requestId });
    if (parsed.data.store_ref !== storeRef) return fail("forbidden", "store_not_allowed", 403, { requestId });
    const limit = await checkRateLimit(`athos:test-launch:${auth.organizationId}:${auth.apiTokenId}`, 10, 3600);
    if (!limit.allowed) {
      return fail("rate_limited", "test_launch_rate_limit_exceeded", 429, {
        requestId, headers: { "Retry-After": "3600" },
      });
    }

    // A synthetic blocked contact keeps the sandbox order isolated from real customers.
    const { data: contact, error: contactError } = await admin
      .from("contacts")
      .insert({
        organization_id: auth.organizationId,
        display_name: "[SANDBOX ATHOS] Cliente de teste",
        is_blocked: true,
        source_metadata: { source: "athos_partner_test_launch" },
      })
      .select("id")
      .single();
    if (contactError || !contact) return fail("internal_error", "test_contact_creation_failed", 500, { requestId });

    const launchId = randomUUID();
    const expiresAt = new Date(Date.now() + LAUNCH_TTL_MS).toISOString();
    const { error: launchError } = await admin.from("partner_launches").insert({
      id: launchId,
      organization_id: auth.organizationId,
      provider: "athos",
      contact_id: contact.id,
      conversation_id: null,
      store_ref: storeRef,
      expires_at: expiresAt,
      metadata: { source: "athos_partner_test_launch", request_id: requestId },
    });
    if (launchError) return fail("internal_error", "test_launch_creation_failed", 500, { requestId });

    void audit({
      action: "athos.launch.created",
      actorApiTokenId: auth.apiTokenId,
      organizationId: auth.organizationId,
      resourceType: "partner_launch",
      resourceId: launchId,
      requestId,
      metadata: { source: "athos_partner_test_launch", store_ref: storeRef, contact_id: contact.id },
    });

    return ok({
      environment: "sandbox",
      launch_id: launchId,
      crm_contact_id: contact.id,
      crm_conversation_id: null,
      store_ref: storeRef,
      expires_at: expiresAt,
    }, { status: 201, requestId, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof McpAuthError) {
      return fail(error.httpStatus === 403 ? "forbidden_scope" : "unauthenticated", error.message, error.httpStatus, { requestId });
    }
    return fail("internal_error", "test_launch_failed", 500, { requestId });
  }
}


import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { fail, ok } from "@/lib/api/wrappers";
import { athosEventSchema, deriveSandboxHmacSecret, isFreshAthosTimestamp, verifyAthosSignature } from "@/lib/athos/contract";
import { authenticateAthosPartner } from "@/lib/athos/partner-auth";
import { McpAuthError } from "@/lib/mcp/auth";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    const { auth, admin, integration, storeRef } = await authenticateAthosPartner(
      req.headers.get("authorization"),
      "athos:events:write",
    );
    const timestamp = req.headers.get("x-athos-timestamp") ?? "";
    if (!isFreshAthosTimestamp(timestamp)) {
      return fail("unauthenticated", "invalid_or_expired_timestamp", 401, { requestId });
    }
    const rawBody = await req.text();
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim();
    const encryptedHmacSecret = integration.webhook_secret_encrypted as unknown as string;
    const configuredHmacSecret = encryptedHmacSecret
      ? await decryptWebhookSecret(admin, encryptedHmacSecret)
      : null;
    const hmacSecret = configuredHmacSecret ?? (bearer ? deriveSandboxHmacSecret(bearer) : "");
    if (!bearer || !hmacSecret || !verifyAthosSignature(timestamp, rawBody, req.headers.get("x-athos-signature"), hmacSecret)) {
      return fail("unauthenticated", "invalid_signature", 401, { requestId });
    }
    let raw: unknown;
    try { raw = JSON.parse(rawBody) as unknown; } catch {
      return fail("invalid_request", "invalid_json", 400, { requestId });
    }
    const parsed = athosEventSchema.safeParse(raw);
    if (!parsed.success) return fail("invalid_request", "event_outside_contract", 422, { requestId, details: parsed.error.flatten() });
    const event = parsed.data;
    if (event.store_ref !== storeRef) return fail("forbidden", "store_not_allowed", 403, { requestId });

    const { data: launch, error: launchError } = await admin
      .from("partner_launches")
      .select("id, contact_id, conversation_id, store_ref")
      .eq("id", event.correlation.launch_id)
      .eq("organization_id", auth.organizationId)
      .eq("provider", "athos")
      .eq("store_ref", storeRef)
      .maybeSingle();
    if (launchError || !launch) return fail("not_found", "launch_not_found", 404, { requestId });
    if ((event.correlation.crm_contact_id && event.correlation.crm_contact_id !== launch.contact_id) ||
        (event.correlation.crm_conversation_id && event.correlation.crm_conversation_id !== launch.conversation_id)) {
      return fail("invalid_request", "correlation_mismatch", 422, { requestId });
    }

    const { data, error } = await admin.rpc("fn_apply_athos_order_event", {
      p_organization_id: auth.organizationId,
      p_contact_id: launch.contact_id,
      p_conversation_id: launch.conversation_id,
      p_event: event,
    });
    if (error || !data) return fail("internal_error", "order_projection_failed", 500, { requestId });
    return ok({ accepted: true, ...data, event_id: event.event_id, environment: "sandbox" }, {
      status: 202,
      requestId,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof McpAuthError) {
      return fail(error.httpStatus === 403 ? "forbidden_scope" : "unauthenticated", error.message, error.httpStatus, { requestId });
    }
    return fail("internal_error", "event_processing_failed", 500, { requestId });
  }
}

import { randomUUID } from "node:crypto";
import { after, type NextRequest, type NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  ATHOS_RATE_LIMIT_PER_MINUTE,
  athosEventSchema,
  isFreshAthosTimestamp,
  verifyAthosSignature,
} from "@/lib/athos/contract";
import {
  authenticateAthosPartner,
  decryptAthosHmacSecret,
  processAthosEvent,
} from "@/lib/athos/service";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const auth = await authenticateAthosPartner(req.headers.get("authorization"), "athos:events:write");
  if (!auth.ok) {
    return fail(auth.code, auth.message, auth.status, { requestId });
  }

  const timestamp = req.headers.get("x-athos-timestamp") ?? "";
  if (!isFreshAthosTimestamp(timestamp)) {
    return fail("unauthenticated", "invalid_or_expired_timestamp", 401, { requestId });
  }

  const rawBody = await req.text();
  const secret = await decryptAthosHmacSecret(auth.connection);
  if (!secret) {
    return fail("internal_error", "partner_secret_unavailable", 500, { requestId });
  }

  const signature = req.headers.get("x-athos-signature");
  if (!verifyAthosSignature(timestamp, rawBody, signature, secret)) {
    await audit({
      action: "athos.webhook_invalid_signature",
      organizationId: auth.connection.organization_id,
      resourceType: "athos_webhook",
      metadata: { store_ref: auth.connection.store_ref },
    });
    return fail("unauthenticated", "invalid_signature", 401, { requestId });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody) as unknown;
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const parsed = athosEventSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", "event_outside_contract", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const event = parsed.data;

  if (event.store_ref !== auth.connection.store_ref) {
    return fail("forbidden", "store_not_allowed", 403, { requestId });
  }

  const admin = createAdminClient();

  // Fast duplicate path: an accepted retry must remain harmless and return 202.
  const { data: duplicate } = await admin
    .from("partner_athos_events")
    .select("id")
    .eq("connection_id", auth.connection.id)
    .eq("event_id", event.event_id)
    .maybeSingle();
  if (duplicate) {
    return ok(
      { accepted: true, duplicate: true, event_id: event.event_id },
      { status: 202, requestId, headers: { "Cache-Control": "no-store" } },
    );
  }

  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count: recentCount, error: countError } = await admin
    .from("partner_athos_events")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", auth.connection.id)
    .gte("received_at", oneMinuteAgo);
  if (countError) {
    logger.warn("[athos.events] rate count failed", {
      organizationId: auth.connection.organization_id,
      errorCode: countError.code,
    });
  } else if ((recentCount ?? 0) >= ATHOS_RATE_LIMIT_PER_MINUTE) {
    return fail("rate_limited", "rate_limit_exceeded", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  const { data: receipt, error: insertError } = await admin
    .from("partner_athos_events")
    .insert({
      organization_id: auth.connection.organization_id,
      connection_id: auth.connection.id,
      event_id: event.event_id,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      store_ref: event.store_ref,
      external_order_id: event.order.id,
      payload: event,
      status: "received",
    })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return ok(
        { accepted: true, duplicate: true, event_id: event.event_id },
        { status: 202, requestId, headers: { "Cache-Control": "no-store" } },
      );
    }
    logger.error("[athos.events] receipt insert failed", {
      organizationId: auth.connection.organization_id,
      eventId: event.event_id,
      errorCode: insertError.code,
    });
    return fail("internal_error", "event_receipt_failed", 500, { requestId });
  }

  const headersForLog: Record<string, string> = {};
  const contentType = req.headers.get("content-type");
  if (contentType) headersForLog["content-type"] = contentType;
  headersForLog["x-athos-timestamp"] = timestamp;

  const { error: logError } = await admin.from("webhook_events_log").insert({
    organization_id: auth.connection.organization_id,
    provider: "athos",
    http_method: "POST",
    headers: headersForLog,
    raw_body: rawBody,
    payload_parsed: event,
    signature_header: signature,
    valid_signature: true,
    event_type: event.event_type,
    external_id: event.event_id,
    status: "received",
    attempts: 0,
  });
  if (logError) {
    logger.warn("[athos.events] webhook log insert failed", {
      organizationId: auth.connection.organization_id,
      eventId: event.event_id,
      errorCode: logError.code,
    });
  }

  await audit({
    action: "athos.webhook_received",
    organizationId: auth.connection.organization_id,
    resourceType: "athos_webhook",
    resourceId: receipt.id as string,
    metadata: { event_id: event.event_id, event_type: event.event_type, store_ref: event.store_ref },
  });

  // Next.js after() keeps the projection outside the response path while still
  // running it within the request lifecycle guarantees of the deployment.
  after(() => processAthosEvent(auth.connection, event, receipt.id as string));

  return ok(
    { accepted: true, duplicate: false, event_id: event.event_id },
    { status: 202, requestId, headers: { "Cache-Control": "no-store" } },
  );
}

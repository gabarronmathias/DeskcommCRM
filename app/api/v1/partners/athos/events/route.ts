import { randomUUID } from "node:crypto";
import { after, type NextRequest, type NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import {
  ATHOS_RATE_LIMIT_PER_MINUTE,
  athosEventSchema,
  deriveAthosSandboxHmacSecret,
  isFreshAthosTimestamp,
  verifyAthosSignature,
} from "@/lib/athos/contract";
import {
  authenticateAthosPartner,
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
  const secret = deriveAthosSandboxHmacSecret(auth.bearerToken);
  const signature = req.headers.get("x-athos-signature");
  if (!verifyAthosSignature(timestamp, rawBody, signature, secret)) {
    logger.warn("[athos.sandbox.events] invalid signature", {
      connectionId: auth.connection.id,
      storeRef: auth.connection.store_ref,
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

  const { data: duplicate } = await admin
    .from("athos_sandbox_events")
    .select("id")
    .eq("connection_id", auth.connection.id)
    .eq("event_id", event.event_id)
    .maybeSingle();
  if (duplicate) {
    return ok(
      { accepted: true, duplicate: true, event_id: event.event_id, environment: "sandbox" },
      { status: 202, requestId, headers: { "Cache-Control": "no-store" } },
    );
  }

  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count: recentCount, error: countError } = await admin
    .from("athos_sandbox_events")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", auth.connection.id)
    .gte("received_at", oneMinuteAgo);
  if (countError) {
    logger.warn("[athos.sandbox.events] rate count failed", {
      connectionId: auth.connection.id,
      errorCode: countError.code,
    });
  } else if ((recentCount ?? 0) >= ATHOS_RATE_LIMIT_PER_MINUTE) {
    return fail("rate_limited", "rate_limit_exceeded", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  const { data: receipt, error: insertError } = await admin
    .from("athos_sandbox_events")
    .insert({
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
        { accepted: true, duplicate: true, event_id: event.event_id, environment: "sandbox" },
        { status: 202, requestId, headers: { "Cache-Control": "no-store" } },
      );
    }
    logger.error("[athos.sandbox.events] receipt insert failed", {
      connectionId: auth.connection.id,
      eventId: event.event_id,
      errorCode: insertError.code,
    });
    return fail("internal_error", "event_receipt_failed", 500, { requestId });
  }

  after(() => processAthosEvent(auth.connection, event, receipt.id as string));

  return ok(
    { accepted: true, duplicate: false, event_id: event.event_id, environment: "sandbox" },
    { status: 202, requestId, headers: { "Cache-Control": "no-store" } },
  );
}

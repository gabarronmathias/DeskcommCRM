/**
 * /api/v1/webhooks/waha/[token]
 *
 * POST = webhook per-session canônico de produção.
 *
 * O auto-reparo da configuração do WAHA é executado pelo watchdog autenticado;
 * esta rota pública aceita somente entregas do provedor.
 */
import { randomUUID } from "node:crypto";
import { after, type NextRequest, type NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchWahaEvent, isInboundMessageEvent, type WahaEnvelope } from "@/lib/waha/ingest";
import { authenticateWahaWebhook } from "@/lib/waha/webhook-auth";
import { runInboundTurnFallback } from "@/lib/agent-engine/worker/inbound-fallback";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const rawBody = await req.text();
  let envelope: WahaEnvelope;
  try {
    envelope = JSON.parse(rawBody) as WahaEnvelope;
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const admin = createAdminClient();

  const base = () =>
    admin
      .from("channel_sessions")
      .select(
        "id, organization_id, waha_session_name, webhook_secret_encrypted, status, is_warmup_complete, warmup_started_at",
      )
      .eq("webhook_path_token", token);
  const { data: session, error: sessErr } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );

  if (sessErr) {
    return fail("internal_error", sessErr.message, 500, { requestId });
  }
  if (!session) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const sigHeader = req.headers.get("x-webhook-hmac") ?? req.headers.get("X-Webhook-Hmac");
  let sessionSecret: string | null = null;
  try {
    const dec = await admin.rpc("fn_decrypt_oauth", {
      ciphertext: session.webhook_secret_encrypted,
    });
    if (!dec.error && typeof dec.data === "string") sessionSecret = dec.data;
  } catch {
    sessionSecret = null;
  }

  const auth = authenticateWahaWebhook({ rawBody, signatureHeader: sigHeader, sessionSecret });
  if (!auth.ok) {
    await audit({
      action: "webhook.hmac_invalid",
      organizationId: session.organization_id,
      metadata: {
        provider: "waha",
        session: session.waha_session_name,
        event: envelope.event,
        reason: auth.reason,
        had_signature: Boolean(sigHeader),
      },
    });
    return fail("unauthenticated", auth.reason, 401, { requestId });
  }
  const validSignature = auth.signatureVerified;

  const eventType = envelope.event ?? "unknown";
  const externalId = envelope.payload?.id ?? null;

  const headersJson: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("authorization")) return;
    if (normalized === "cookie" || normalized === "x-webhook-hmac" || normalized === "x-api-key") {
      return;
    }
    headersJson[key] = value;
  });
  const { data: eventLog, error: eventLogError } = await admin
    .from("webhook_events_log")
    .insert({
    organization_id: session.organization_id,
    channel_session_id: session.id,
    provider: "waha",
    webhook_path_token: token,
    http_method: "POST",
    headers: headersJson,
    raw_body: rawBody,
    payload_parsed: envelope as unknown as Record<string, unknown>,
    signature_header: sigHeader ? "[redacted]" : null,
    valid_signature: validSignature,
    event_type: eventType,
    external_id: externalId,
    status: "received",
    attempts: 0,
    })
    .select("id")
    .single();

  if (eventLogError || !eventLog) {
    logger.error("waha.webhook: failed to persist event before dispatch", {
      request_id: requestId,
      channel_session_id: session.id,
      event_type: eventType,
      error_code: eventLogError?.code,
    });
    return fail("internal_error", "webhook event could not be persisted", 500, { requestId });
  }

  try {
    await dispatchWahaEvent(admin, session, envelope, requestId);
    const { error: processedError } = await admin
      .from("webhook_events_log")
      .update({ status: "processed", processed_at: new Date().toISOString(), attempts: 1 })
      .eq("id", eventLog.id);
    if (processedError) {
      logger.warn("waha.webhook: event processed but audit status update failed", {
        request_id: requestId,
        webhook_event_id: eventLog.id,
        error_code: processedError.code,
      });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message.slice(0, 1_000) : "unknown dispatch error";
    await admin
      .from("webhook_events_log")
      .update({ status: "error", error_message: errorMessage, attempts: 1 })
      .eq("id", eventLog.id);
    logger.error("waha.webhook: dispatch failed", {
      request_id: requestId,
      webhook_event_id: eventLog.id,
      channel_session_id: session.id,
      event_type: eventType,
    });
    return fail("webhook_dispatch_failed", "temporary webhook processing failure", 500, {
      requestId,
    });
  }

  if (isInboundMessageEvent(envelope)) {
    after(() =>
      runInboundTurnFallback().catch((error: unknown) => {
        logger.error("waha.webhook: fallback do turno inbound falhou", {
          request_id: requestId,
          channel_session_id: session.id,
          error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
        });
      }),
    );
  }

  return ok({ accepted: true }, { requestId });
}

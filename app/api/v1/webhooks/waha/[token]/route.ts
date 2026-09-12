/**
 * POST /api/v1/webhooks/waha/[token]
 *
 * Rota per-tenant canônica de produção: cada channel_session tem um
 * webhook_path_token único url-safe. Pipeline: lookup por token -> verifica
 * HMAC SHA512 -> loga em webhook_events_log -> dispatchWahaEvent (ingestão
 * compartilhada, ver lib/waha/ingest.ts).
 *
 * Idempotência e resolução atômica de contato/conversa vivem no módulo
 * compartilhado — este handler só faz auth + roteamento.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { handleAthosTestInbound } from "@/lib/waha/athos-test";
import { dispatchWahaEvent, verifyHmacSha512, type WahaEnvelope } from "@/lib/waha/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  const receivedAt = Date.now();
  let envelope: WahaEnvelope;
  try {
    envelope = JSON.parse(rawBody) as WahaEnvelope;
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const admin = createAdminClient();

  const { data: session, error: sessErr } = await admin
    .from("channel_sessions")
    .select(
      "id, organization_id, waha_session_name, webhook_secret_encrypted, status, is_warmup_complete, warmup_started_at",
    )
    .eq("webhook_path_token", token)
    .maybeSingle();

  if (sessErr) {
    return fail("internal_error", sessErr.message, 500, { requestId });
  }
  if (!session) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  // HMAC (best-effort: se fn_decrypt_oauth falhar — ex. seed dev sem cripto —
  // loga e pula para o MVP).
  const sigHeader = req.headers.get("x-webhook-hmac") ?? req.headers.get("X-Webhook-Hmac");
  let validSignature = false;
  let hmacSkipped = false;
  const requireSignature = process.env.WAHA_WEBHOOK_REQUIRE_SIGNATURE !== "false";
  try {
    const dec = await admin.rpc("fn_decrypt_oauth", {
      ciphertext: session.webhook_secret_encrypted,
    });
    if (dec.error || !dec.data) {
      hmacSkipped = true;
    } else {
      validSignature = verifyHmacSha512(rawBody, sigHeader, dec.data as string);
    }
    // WAHA self-hosted assina com o segredo global configurado em
    // WHATSAPP_HOOK_HMAC. Aceitamos esse segredo como fallback quando uma
    // sessão legada ainda não tem o mesmo segredo individual no CRM.
    if (!validSignature && process.env.WAHA_HMAC_SECRET) {
      validSignature = verifyHmacSha512(rawBody, sigHeader, process.env.WAHA_HMAC_SECRET);
    }
  } catch {
    hmacSkipped = true;
  }

  if (requireSignature && !hmacSkipped && !validSignature) {
    await audit({
      action: "nuvemshop.webhook_invalid_signature",
      organizationId: session.organization_id,
      metadata: { provider: "waha", session: session.waha_session_name, event: envelope.event },
    });
    return fail("unauthenticated", "invalid_signature", 401, { requestId });
  }

  const eventType = envelope.event ?? "unknown";
  const externalId = envelope.payload?.id ?? null;

  const isMessageEvent = eventType === "message" || eventType === "message.any";
  if (isMessageEvent) {
    // Phase 1 emergency isolation: do not enter ingest/CRM/agent for inbound
    // messages. Outbound echoes are acknowledged and ignored to prevent loops.
    if (envelope.payload?.fromMe) return ok({ accepted: true }, { requestId });
    try {
      await handleAthosTestInbound(admin, session, envelope, receivedAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ATHOS-TEST] webhook_failed", err);
      return fail("internal_error", `athos_test_failed: ${message}`, 503, { requestId });
    }
    return ok({ accepted: true }, { requestId });
  }

  const headersJson: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("authorization")) return;
    if (key.toLowerCase() === "cookie") return;
    headersJson[key] = value;
  });
  const { error: webhookLogError } = await admin.from("webhook_events_log").insert({
    organization_id: session.organization_id,
    channel_session_id: session.id,
    provider: "waha",
    webhook_path_token: token,
    http_method: "POST",
    headers: headersJson,
    raw_body: rawBody,
    payload_parsed: envelope as unknown as Record<string, unknown>,
    signature_header: sigHeader ?? null,
    valid_signature: validSignature || hmacSkipped,
    event_type: eventType,
    external_id: externalId,
    status: "received",
    attempts: 0,
  });
  if (webhookLogError) {
    console.error("[waha.webhook] webhook event log failed", webhookLogError.message);
    return fail("internal_error", "webhook_log_retryable", 503, { requestId });
  }

  try {
    await dispatchWahaEvent(admin, session, envelope, requestId);
  } catch (err) {
    console.error("[waha.webhook] handler failed", err);
    return fail("internal_error", "webhook_ingest_retryable", 503, { requestId });
  }

  return ok({ accepted: true }, { requestId });
}

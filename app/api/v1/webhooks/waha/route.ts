/**
 * POST /api/v1/webhooks/waha — global webhook receiver (no path token).
 *
 * Usado quando o WAHA tem um único WHATSAPP_HOOK_URL global (docker-compose
 * atual). Resolve a channel_session por `body.session` (= waha_session_name).
 * A variante /waha/[token] é a rota per-tenant canônica de produção.
 *
 * Pipeline: lookup session -> verifica HMAC SHA512 -> loga em
 * webhook_events_log -> dispatchWahaEvent (ingestão compartilhada, ver
 * lib/waha/ingest.ts). Idempotência e resolução atômica de contato/conversa
 * vivem no módulo compartilhado.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchWahaEvent, verifyHmacSha512, type WahaEnvelope } from "@/lib/waha/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const rawBody = await req.text();
  let envelope: WahaEnvelope;
  try {
    envelope = JSON.parse(rawBody) as WahaEnvelope;
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const sessionName = envelope.session;
  if (!sessionName) {
    return fail("invalid_request", "missing session field", 400, { requestId });
  }

  const admin = createAdminClient();

  const { data: session, error: sessErr } = await admin
    .from("channel_sessions")
    .select(
      "id, organization_id, waha_session_name, webhook_secret_encrypted, status, is_warmup_complete, warmup_started_at",
    )
    .eq("waha_session_name", sessionName)
    .maybeSingle();

  if (sessErr) {
    return fail("internal_error", sessErr.message, 500, { requestId });
  }
  if (!session) {
    // Sessão ainda não registrada no nosso DB — aceita e ignora (200 p/ WAHA
    // não ficar retentando). Comum quando a sessão foi iniciada pelo dashboard
    // antes da nossa linha existir.
    return ok(
      { accepted: false, reason: "session_not_registered", session: sessionName },
      { requestId },
    );
  }

  // HMAC — pula em dev quando o secret é o placeholder.
  const sigHeader = req.headers.get("x-webhook-hmac") ?? req.headers.get("X-Webhook-Hmac");
  let validSignature = false;
  let hmacSkipped = false;
  const requireSignature = process.env.WAHA_WEBHOOK_REQUIRE_SIGNATURE !== "false";
  try {
    const dec = await admin.rpc("fn_decrypt_oauth", {
      ciphertext: session.webhook_secret_encrypted,
    });
    if (dec.error || !dec.data || (typeof dec.data === "string" && dec.data.length < 4)) {
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
    webhook_path_token: null,
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

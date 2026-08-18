/**
 * /api/v1/webhooks/waha/[token]
 *
 * POST = webhook per-session canônico de produção.
 * GET ?repair=1 = auto-reparo idempotente e estreitamente escopado: o token só
 * pode reparar a própria channel_session e a URL é sempre esta própria rota.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";
import { ensureWahaSessionWebhook } from "@/lib/waha/session-webhook";
import { authenticateWahaWebhook } from "@/lib/waha/webhook-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

/**
 * Diagnóstico + reparo operacional para a sessão já pareada.
 * Não aceita session name nem URL do chamador: ambos vêm do banco/req atual.
 */
export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;
  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }
  if (new URL(req.url).searchParams.get("repair") !== "1") {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const admin = createAdminClient();
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, organization_id, waha_session_name, status")
      .eq("webhook_path_token", token);
  const { data: session, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!session?.waha_session_name) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const webhookUrl = `${new URL(req.url).origin}/api/v1/webhooks/waha/${encodeURIComponent(token)}`;
  try {
    await ensureWahaSessionWebhook(session.waha_session_name, webhookUrl);
  } catch (err) {
    return fail(
      "waha_webhook_repair_failed",
      err instanceof Error ? err.message : "webhook repair failed",
      502,
      { requestId },
    );
  }

  return ok(
    {
      repaired: true,
      channel_session_id: session.id,
      session_status: session.status,
      webhook_url: webhookUrl,
    },
    { requestId },
  );
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
    if (key.toLowerCase().startsWith("authorization")) return;
    if (key.toLowerCase() === "cookie") return;
    headersJson[key] = value;
  });
  await admin.from("webhook_events_log").insert({
    organization_id: session.organization_id,
    channel_session_id: session.id,
    provider: "waha",
    webhook_path_token: token,
    http_method: "POST",
    headers: headersJson,
    raw_body: rawBody,
    payload_parsed: envelope as unknown as Record<string, unknown>,
    signature_header: sigHeader ?? null,
    valid_signature: validSignature,
    event_type: eventType,
    external_id: externalId,
    status: "received",
    attempts: 0,
  });

  try {
    await dispatchWahaEvent(admin, session, envelope, requestId);
  } catch (err) {
    console.error("[waha.webhook] handler failed", err);
  }

  return ok({ accepted: true }, { requestId });
}

/**
 * GET  /api/v1/channel-sessions — lista os canais WhatsApp da org (do DB).
 *   Acessível a qualquer membro (usado pelo seletor do inbox e pela sidebar).
 * POST /api/v1/channel-sessions — inicia o único canal WhatsApp da organização.
 *   Repetir o clique reutiliza a sessão existente, inclusive após exclusão.
 *
 * Garantia de produção: toda nova sessão sai do onboarding com webhook inbound canônico no WAHA.
 * organization_id resolvido da sessão (cookie) — nunca do body.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { createChannelSchema } from "@/lib/schemas/channels";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient, wahaFriendlyError } from "@/lib/waha/client";
import { canonicalWahaWebhookUrl, ensureWahaSessionWebhook } from "@/lib/waha/session-webhook";

export const dynamic = "force-dynamic";

export const CHANNEL_COLUMNS =
  "id, waha_session_name, display_name, phone_number, status, status_reason, last_health_check_at, last_status_change_at, daily_message_limit, is_warmup_complete, created_at";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("forbidden_tenant", "Nenhuma organização ativa.", 403, { requestId });

  const supabase = await createClient();
  const base = () =>
    supabase
      .from("channel_sessions")
      .select(CHANNEL_COLUMNS)
      .eq("organization_id", activeOrg.orgId);
  const { data, error, schemaOutdated } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).order("created_at", { ascending: true }),
    () => base().order("created_at", { ascending: true }),
  );
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], {
    requestId,
    ...(schemaOutdated ? { meta: { schema_outdated: true } } : {}),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const waha = getWahaClient();
  if (!waha) {
    return fail(
      "waha_not_configured",
      "O WhatsApp (WAHA) não está configurado neste ambiente: faltam WAHA_API_BASE_URL e/ou WAHA_API_KEY. Configure-as e tente de novo.",
      503,
      { requestId },
    );
  }

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createChannelSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  // This endpoint used to generate a random WAHA name on every click. That
  // made “Conectar novo WhatsApp” create another database row and another
  // remote session each time. A QR channel is singular per organization:
  // reuse the latest WAHA row, including an archived row restored by Delete.
  const findExisting = () =>
    supabase
      .from("channel_sessions")
      .select(`${CHANNEL_COLUMNS}, webhook_path_token, ${ARCHIVED_AT}`)
      .eq("organization_id", activeOrg.orgId)
      .not("waha_session_name", "is", null)
      .order("phone_number", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  const { data: existingRaw, error: existingErr, schemaOutdated } =
    await queryTolerantToMissingArchived(
      findExisting,
      () =>
        supabase
          .from("channel_sessions")
          .select(`${CHANNEL_COLUMNS}, webhook_path_token`)
          .eq("organization_id", activeOrg.orgId)
          .not("waha_session_name", "is", null)
          .order("phone_number", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
    );
  if (existingErr) return fail("internal_error", existingErr.message, 500, { requestId });

  const existing = existingRaw as
    | (Record<string, unknown> & {
        id: string;
        waha_session_name: string | null;
        webhook_path_token: string | null;
        archived_at?: string | null;
        status?: string | null;
      })
    | null;
  const sessionName = existing?.waha_session_name ?? `org_${activeOrg.orgId.slice(0, 8)}`;
  const webhookPathToken = existing?.webhook_path_token ?? randomUUID().replace(/-/g, "");
  const webhookUrl = canonicalWahaWebhookUrl(req.url, webhookPathToken);

  // A second click while the QR is already being shown (or after it is
  // connected) is a no-op. It must never restart or duplicate the session.
  if (
    existing?.id &&
    !existing.archived_at &&
    ["STARTING", "SCAN_QR_CODE", "WORKING"].includes(existing.status ?? "")
  ) {
    return ok(existing, {
      requestId,
      ...(schemaOutdated ? { meta: { schema_outdated: true } } : {}),
    });
  }

  if (existing?.id) {
    const patch = {
      status: "STARTING",
      last_status_change_at: new Date().toISOString(),
      consecutive_health_fails: 0,
      webhook_path_token: webhookPathToken,
    };
    if (existing.archived_at) {
      const { error } = await reactivateChannelSession(
        supabase,
        {
          organizationId: activeOrg.orgId,
          channelSessionId: existing.id,
          archivedAt: existing.archived_at,
        },
        patch,
        {
          userId: user.id,
          requestId,
          metadata: { provider: "waha", origin: "connections" },
        },
      );
      if (error) return fail("internal_error", error.message, 500, { requestId });
    } else {
      const { error } = await supabase
        .from("channel_sessions")
        .update(patch)
        .eq("organization_id", activeOrg.orgId)
        .eq("id", existing.id);
      if (error) return fail("internal_error", error.message, 500, { requestId });
    }

    try {
      await ensureWahaSessionWebhook(sessionName, webhookUrl);
      let remote: { status?: string };
      try {
        remote = (await waha.startSession(sessionName)) as { status?: string };
      } catch (err) {
        // WAHA answers 409/422 when the same idempotent start is already in
        // flight. Read its state instead of turning a second click into an
        // error (or creating a new session).
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("409") && !message.includes("422")) throw err;
        remote = (await waha.getSessionQr(sessionName)) as { status?: string };
      }
      return ok(
        { ...existing, ...patch, id: existing.id, waha_session_name: sessionName, status: remote.status ?? "STARTING" },
        { requestId, ...(schemaOutdated ? { meta: { schema_outdated: true } } : {}) },
      );
    } catch (err) {
      return fail("waha_error", wahaFriendlyError(err), 502, { requestId });
    }
  }

  const { data: created, error: insErr } = await supabase
    .from("channel_sessions")
    .insert({
      organization_id: activeOrg.orgId,
      waha_session_name: sessionName,
      display_name: parsed.data.display_name ?? null,
      engine: "NOWEB",
      webhook_path_token: webhookPathToken,
      webhook_secret_encrypted: Buffer.from([0]),
      status: "STARTING",
      last_status_change_at: new Date().toISOString(),
      consecutive_health_fails: 0,
      daily_message_limit: 250,
      metadata: {},
    })
    .select(CHANNEL_COLUMNS)
    .single();
  if (insErr || !created) {
    return fail("internal_error", insErr?.message ?? "channel_session_insert_failed", 500, { requestId });
  }

  try {
    await waha.startSession(sessionName);
    // WORKING sem inbound é um falso positivo perigoso: toda sessão criada por
    // este app precisa sair do onboarding já com o webhook canônico gravado no WAHA.
    await ensureWahaSessionWebhook(sessionName, webhookUrl);
  } catch (err) {
    await supabase
      .from("channel_sessions")
      .delete()
      .eq("organization_id", activeOrg.orgId)
      .eq("id", created.id);
    return fail("waha_error", wahaFriendlyError(err), 502, { requestId });
  }

  void audit({
    action: "channel.connected",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "channel_session",
    resourceId: created.id,
    requestId,
    metadata: { waha_session_name: sessionName, webhook_configured: true },
  });

  return ok(created, { requestId, status: 201 });
}

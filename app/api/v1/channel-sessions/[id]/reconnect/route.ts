/**
 * POST /api/v1/channel-sessions/[id]/reconnect — reconecta um canal caído.
 *
 * O webhook da sessão é reaplicado em cada start. A sessão é criada/iniciada
 * primeiro porque um WAHA novo não tem registro remoto para receber o PUT.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient, wahaFriendlyError } from "@/lib/waha/client";
import { canonicalWahaWebhookUrl, ensureWahaSessionWebhook } from "@/lib/waha/session-webhook";

export const dynamic = "force-dynamic";

const reconnectSchema = z.object({ force: z.boolean().optional() });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  let rawBody: unknown = {};
  try {
    rawBody = await req.json();
  } catch {
    rawBody = {};
  }
  const parsedBody = reconnectSchema.safeParse(rawBody ?? {});
  const force = parsedBody.success ? (parsedBody.data.force ?? false) : false;

  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const buscar = (colunas: string) =>
    supabase
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", activeOrg.orgId)
      .eq("id", id)
      .maybeSingle();
  const { data: sessionRaw } = await queryTolerantToMissingArchived(
    () => buscar(`id, waha_session_name, webhook_path_token, ${ARCHIVED_AT}`),
    () => buscar("id, waha_session_name, webhook_path_token"),
  );
  const session = sessionRaw as {
    id: string;
    waha_session_name: string | null;
    webhook_path_token: string | null;
    archived_at?: string | null;
  } | null;

  if (!session) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  if (session.archived_at) {
    return fail(
      "channel_archived",
      "Este número foi excluído da Central de Conexões — reconectar não o traz de volta. Conecte um número para voltar a atender.",
      409,
      { requestId },
    );
  }

  const nomeSessao = session.waha_session_name;
  if (!nomeSessao) {
    return fail(
      "channel_without_session",
      "Este canal é o oficial (API da plataforma): ele não tem sessão de WhatsApp para reiniciar. Se parou de entregar, atualize a credencial na tela do canal oficial.",
      422,
      { requestId },
    );
  }
  if (!session.webhook_path_token) {
    return fail(
      "channel_webhook_missing",
      "Este canal não possui token de webhook. Reconecte o número como um novo canal.",
      409,
      { requestId },
    );
  }

  const waha = getWahaClient();
  if (!waha) {
    return fail(
      "waha_not_configured",
      "O WhatsApp (WAHA) não está configurado neste ambiente: faltam WAHA_API_BASE_URL e/ou WAHA_API_KEY. Configure-as e tente de novo.",
      503,
      { requestId },
    );
  }

  const webhookUrl = canonicalWahaWebhookUrl(req.url, session.webhook_path_token);

  try {
    await waha.stopSession(nomeSessao);
    if (force) await waha.logoutSession(nomeSessao);

    // Persiste o estado ANTES de iniciar o transporte. Se o WAHA responder
    // WORKING muito rápido, o webhook enxerga STARTING e registra uma única
    // transição real para WORKING; gravar STARTING depois do start podia
    // sobrescrever essa confirmação e disparar a prospecção repetidamente.
    await supabase
      .from("channel_sessions")
      .update({
        status: "STARTING",
        last_status_change_at: new Date().toISOString(),
        consecutive_health_fails: 0,
      })
      .eq("organization_id", activeOrg.orgId)
      .eq("id", id);

    await waha.startSession(nomeSessao);
    // A chamada retorna ao browser somente depois do webhook estar salvo. Assim
    // o QR não é exibido antes de a sessão poder entregar os eventos inbound.
    await ensureWahaSessionWebhook(nomeSessao, webhookUrl);
    const remote = (await waha.startSession(nomeSessao)) as { status?: string };
    const nextStatus = remote.status ?? "STARTING";

    void audit({
      action: "channel.reconnected",
      actorUserId: user.id,
      organizationId: activeOrg.orgId,
      resourceType: "channel_session",
      resourceId: id,
      requestId,
      metadata: { waha_session_name: nomeSessao, force, webhook_configured: true },
    });

    return ok({ id, status: nextStatus, force, webhook_configured: true }, { requestId });
  } catch (err) {
    return fail("waha_error", wahaFriendlyError(err), 502, { requestId });
  }
}

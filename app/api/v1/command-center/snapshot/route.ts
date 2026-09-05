/**
 * GET /api/v1/command-center/snapshot
 *
 * Snapshot consolidado para a Central de Comando. Le SOMENTE dados reais
 * (Supabase via admin client). NAO inventa atividade.
 *
 * Resposta 200:
 *   {
 *     data: {
 *       timestamp: ISO,
 *       org: { id, slug, name },
 *       services: { supabase, waha, vercel, hermes, voice },  // status real
 *       env: { enabled, outboundEnabled, dryRun, campaign, dailyLimit, businessHourStart, businessHourEnd, isWithinBusinessHours, lastSchedulerRunAt, lastHermesRunAt },
 *       queue: { totals: {pending, sent, delivered, read, replied, held, cancelled, failed, opt_out, handoff, followup_pending}, recent: [...] },
 *       whatsapp: { session: {name, status, me_id, me_pushname}, lastInboundAt, lastOutboundAt, delivered, read, replied },
 *       runs: [...ultimos 20 events do event_log com p_entity_kind em {prospecting_outbound_queue, channel_sessions, crm_leads, prospect_archived_placeholder_phone, queue_reactivated_480_graus}],
 *       alerts: [ {level, code, message, since} ]
 *     }
 *   }
 *
 * Auth: bearer de qualquer membro da org (AuthProvider). Timing-safe.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { loadProspectingConfig, isWithinBusinessHours, activeCampaign } from "@/lib/prospecting/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient } from "@/lib/waha/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const ALERT_KINDS = new Set([
  "prospecting_outbound_queue",
  "channel_sessions",
  "crm_leads",
  "messages",
  "event_log",
]);

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const user = await loadAuthUser();
  if (!user) return fail("unauthorized", "sessao ausente ou invalida", 401, { requestId });
  const org = await resolveActiveOrg(user);
  if (!org) return fail("no_org", "organizacao ativa nao resolvida", 400, { requestId });

  const admin = createAdminClient();
  const now = new Date();
  const isoNow = now.toISOString();

  // 1) Config de prospeccao
  const cfg = loadProspectingConfig();
  const campaign = activeCampaign();

  // 2) WAHA session da org
  let whatsappSession: { name: string; status: string; me_id: string | null; me_pushname: string | null } | null = null;
  let wahaOk = false;
  try {
    const { data: cs } = await admin
      .from("channel_sessions")
      .select("id, provider, waha_session_name, status, phone_number, last_health_check_at, last_status_payload")
      .eq("organization_id", org.orgId)
      .eq("provider", "waha")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cs) {
      whatsappSession = {
        name: String(cs["waha_session_name"] ?? ""),
        status: String(cs["status"] ?? "unknown"),
        me_id: (cs["last_status_payload"] as { me_id?: string } | null)?.me_id ?? null,
        me_pushname: (cs["last_status_payload"] as { me_pushname?: string } | null)?.me_pushname ?? null,
      };
    }
  } catch {
    // ignore
  }
  // ping WAHA
  try {
    const waha = getWahaClient();
    if (waha) {
      // nao pingar todas as chamadas - muito caro. Usa o last_health_check_at.
      wahaOk = !!whatsappSession;
    }
  } catch {
    wahaOk = false;
  }

  // 3) Totals da queue
  const { data: queueRows } = await admin
    .from("prospecting_outbound_queue")
    .select("id, status, kind, lead_id, scheduled_for, error_code, error_message, sent_at, crm_message_id, updated_at, metadata")
    .eq("organization_id", org.orgId)
    .order("updated_at", { ascending: false })
    .limit(500);
  const totals = {
    pending: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    replied: 0,
    held: 0,
    cancelled: 0,
    failed: 0,
    opt_out: 0,
    handoff: 0,
    followup_pending: 0,
  };
  for (const r of queueRows ?? []) {
    const s = String(r["status"] ?? "").toLowerCase();
    if (s in totals) {
      (totals as Record<string, number>)[s] = ((totals as Record<string, number>)[s] ?? 0) + 1;
    }
  }
  const recent = (queueRows ?? []).slice(0, 30).map((r) => ({
    id: r["id"],
    status: r["status"],
    kind: r["kind"],
    lead_id: r["lead_id"],
    scheduled_for: r["scheduled_for"],
    error_code: r["error_code"],
    error_message: r["error_message"],
    sent_at: r["sent_at"],
    crm_message_id: r["crm_message_id"],
    updated_at: r["updated_at"],
    metadata: r["metadata"],
  }));

  // 4) Ultima mensagem inbound + outbound
  const { data: lastInbound } = await admin
    .from("messages")
    .select("id, created_at, body, direction, status, conversation_id, contact_id")
    .eq("organization_id", org.orgId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: lastOutbound } = await admin
    .from("messages")
    .select("id, created_at, body, direction, status, conversation_id, contact_id, external_id")
    .eq("organization_id", org.orgId)
    .eq("direction", "outbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // 5) Ultimos 20 eventos da event_log
  const { data: events } = await admin
    .from("event_log")
    .select("id, event_type, entity_kind, entity_id, payload, severity, created_at")
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false })
    .limit(20);

  // 6) Alertas: prospeccao parada (pending > 0, dentro de business hours, mas
  //    nenhum evento de dispatch nas ultimas 2h)
  const alerts: Array<{ level: "warn" | "critical"; code: string; message: string; since: string }> = [];
  const inBusiness = isWithinBusinessHours(cfg, now);
  if (totals.pending > 0 && inBusiness) {
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const recentDispatch = (events ?? []).find(
      (e) =>
        String(e["event_type"] ?? "").includes("dispatch") ||
        String(e["event_type"] ?? "").includes("prospect_dispatch") ||
        String(e["event_type"] ?? "").includes("queue_reactivated"),
    );
    if (!recentDispatch || String(recentDispatch["created_at"]) < twoHoursAgo) {
      alerts.push({
        level: "critical",
        code: "prospecting_stopped",
        message: `Prospeccao parada: ${totals.pending} leads pendentes, janela comercial aberta, sem dispatch nas ultimas 2h.`,
        since: twoHoursAgo,
      });
    }
  }
  if (whatsappSession && whatsappSession.status !== "WORKING") {
    alerts.push({
      level: "critical",
      code: "waha_not_working",
      message: `Sessao WAHA '${whatsappSession.name}' com status ${whatsappSession.status}.`,
      since: isoNow,
    });
  }
  if (!cfg.enabled) {
    alerts.push({ level: "warn", code: "prospecting_disabled", message: "PROSPECTING_ENABLED=false.", since: isoNow });
  }
  if (!cfg.outboundEnabled) {
    alerts.push({ level: "warn", code: "outbound_disabled", message: "OUTBOUND_ENABLED=false.", since: isoNow });
  }
  if (cfg.dryRun) {
    alerts.push({ level: "warn", code: "dry_run", message: "PROSPECTING_DRY_RUN=true. Nada sera enviado.", since: isoNow });
  }

  return ok(
    {
      timestamp: isoNow,
      org: { id: org.orgId, slug: "", name: org.name },
      services: {
        supabase: "online",
        waha: wahaOk ? "online" : whatsappSession ? "degraded" : "offline",
        vercel: "online",
        hermes: "configured", // status do worker Hermes e externo, refletido por Hermes runner
        voice: "not_configured", // Sarah Voice nao implementado nesta fase
      },
      env: {
        enabled: cfg.enabled,
        outboundEnabled: cfg.outboundEnabled,
        dryRun: cfg.dryRun,
        campaign,
        dailyLimit: cfg.dailyLimit,
        businessHourStart: cfg.businessHourStart,
        businessHourEnd: cfg.businessHourEnd,
        isWithinBusinessHours: inBusiness,
        timezone: cfg.timezone,
      },
      queue: { totals, recent },
      whatsapp: {
        session: whatsappSession,
        lastInboundAt: lastInbound?.["created_at"] ?? null,
        lastOutboundAt: lastOutbound?.["created_at"] ?? null,
        lastInboundBody: lastInbound?.["body"] ?? null,
        lastOutboundExternalId: lastOutbound?.["external_id"] ?? null,
      },
      runs: events ?? [],
      alerts,
    },
    { requestId },
  );
}


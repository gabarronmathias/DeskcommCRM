import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { activeCampaign, isWithinBusinessHours, loadProspectingConfig } from "@/lib/prospecting/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient } from "@/lib/waha/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

type Alert = { level: "warn" | "critical"; code: string; message: string; since: string };
type EventRow = {
  id: string;
  event_type: string;
  entity_kind: string;
  entity_id: string | null;
  payload: Record<string, unknown> | null;
  severity: string | null;
  created_at: string;
};

function ageMs(iso: string | null | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, now.getTime() - t) : Number.POSITIVE_INFINITY;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const user = await loadAuthUser();
  if (!user) return fail("unauthorized", "sessao ausente ou invalida", 401, { requestId });
  const org = await resolveActiveOrg(user);
  if (!org) return fail("no_org", "organizacao ativa nao resolvida", 400, { requestId });

  const admin = createAdminClient();
  const now = new Date();
  const isoNow = now.toISOString();
  const cfg = loadProspectingConfig();
  const campaign = activeCampaign();

  let whatsappSession: { name: string; status: string; me_id: string | null; me_pushname: string | null } | null = null;
  let wahaOk = false;
  try {
    const { data: cs } = await admin
      .from("channel_sessions")
      .select("id, provider, waha_session_name, status, phone_number, last_health_check_at, last_status_payload")
      .eq("organization_id", org.orgId)
      .eq("provider", "waha")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cs) {
      const payload = cs["last_status_payload"] as { me_id?: string; me_pushname?: string } | null;
      whatsappSession = {
        name: String(cs["waha_session_name"] ?? ""),
        status: String(cs["status"] ?? "unknown"),
        me_id: payload?.me_id ?? null,
        me_pushname: payload?.me_pushname ?? null,
      };
    }
    wahaOk = !!getWahaClient() && whatsappSession?.status === "WORKING";
  } catch {
    wahaOk = false;
  }

  const { data: queueRows } = await admin
    .from("prospecting_outbound_queue")
    .select("id, status, kind, lead_id, scheduled_for, error_code, error_message, sent_at, crm_message_id, updated_at, metadata")
    .eq("organization_id", org.orgId)
    .order("updated_at", { ascending: false })
    .limit(500);

  const totals: Record<string, number> = {
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
  for (const row of queueRows ?? []) {
    const status = String(row["status"] ?? "").toLowerCase();
    if (status in totals) totals[status] = (totals[status] ?? 0) + 1;
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

  const { data: rawEvents } = await admin
    .from("event_log")
    .select("id, event_type, entity_kind, entity_id, payload, severity, created_at")
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false })
    .limit(50);
  const events = (rawEvents ?? []) as EventRow[];

  const lastHermes = events.find((e) => e.event_type.startsWith("hermes.")) ?? null;
  const lastDispatch = events.find((e) => e.event_type.startsWith("prospecting.dispatch")) ?? null;
  const hermesAge = ageMs(lastHermes?.created_at, now);
  const dispatchAge = ageMs(lastDispatch?.created_at, now);
  const twoHours = 2 * 60 * 60_000;
  const thirtyMinutes = 30 * 60_000;

  let hermesStatus = "offline";
  if (lastHermes) {
    if (lastHermes.event_type === "hermes.discovery_blocked") hermesStatus = "degraded";
    else if (hermesAge <= twoHours) hermesStatus = "online";
    else hermesStatus = "offline";
  }
  const schedulerStatus = dispatchAge <= thirtyMinutes ? "running" : "stale";

  const alerts: Alert[] = [];
  const inBusiness = isWithinBusinessHours(cfg, now);
  if ((totals.pending ?? 0) > 0 && inBusiness && dispatchAge > twoHours) {
    const since = new Date(now.getTime() - twoHours).toISOString();
    alerts.push({
      level: "critical",
      code: "prospecting_stopped",
      message: `Prospeccao parada: ${totals.pending ?? 0} leads pendentes, janela comercial aberta, sem dispatch nas ultimas 2h.`,
      since,
    });
  }
  if (lastHermes?.event_type === "hermes.discovery_blocked") {
    const reason = String(lastHermes.payload?.["reason"] ?? "unknown");
    alerts.push({
      level: "critical",
      code: "hermes_discovery_blocked",
      message: `Hermes nao esta descobrindo novos leads: ${reason}.`,
      since: lastHermes.created_at,
    });
  } else if (!lastHermes || hermesAge > twoHours) {
    alerts.push({
      level: "warn",
      code: "hermes_stale",
      message: "Hermes sem execucao de discovery confirmada nas ultimas 2h.",
      since: lastHermes?.created_at ?? isoNow,
    });
  }
  if (whatsappSession && whatsappSession.status !== "WORKING") {
    alerts.push({
      level: "critical",
      code: "waha_not_working",
      message: `Sessao WAHA '${whatsappSession.name}' com status ${whatsappSession.status}.`,
      since: isoNow,
    });
  }
  if (!cfg.enabled) alerts.push({ level: "warn", code: "prospecting_disabled", message: "PROSPECTING_ENABLED=false.", since: isoNow });
  if (!cfg.outboundEnabled) alerts.push({ level: "warn", code: "outbound_disabled", message: "OUTBOUND_ENABLED=false.", since: isoNow });
  if (cfg.dryRun) alerts.push({ level: "warn", code: "dry_run", message: "PROSPECTING_DRY_RUN=true. Nada sera enviado.", since: isoNow });

  return ok(
    {
      timestamp: isoNow,
      org: { id: org.orgId, slug: "", name: org.name },
      services: {
        supabase: "online",
        waha: wahaOk ? "online" : whatsappSession ? "degraded" : "offline",
        vercel: process.env.VERCEL ? "online" : "not_configured",
        hermes: hermesStatus,
        scheduler: schedulerStatus,
        voice: "not_configured",
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
        lastSchedulerRunAt: lastDispatch?.created_at ?? null,
        lastHermesRunAt: lastHermes?.created_at ?? null,
      },
      queue: { totals, recent },
      whatsapp: {
        session: whatsappSession,
        lastInboundAt: lastInbound?.["created_at"] ?? null,
        lastOutboundAt: lastOutbound?.["created_at"] ?? null,
        lastInboundBody: lastInbound?.["body"] ?? null,
        lastOutboundExternalId: lastOutbound?.["external_id"] ?? null,
      },
      runs: events.slice(0, 20),
      alerts,
    },
    { requestId },
  );
}

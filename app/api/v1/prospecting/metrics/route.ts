import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "prospecting.metrics" });
  if (!auth.ok) return auth.response;
  const db = await createClient();
  const orgId = auth.org.orgId;
  const start = new Date();
  start.setUTCHours(3, 0, 0, 0); // meia-noite em America/Sao_Paulo no piloto (UTC-3)
  if (start > new Date()) start.setUTCDate(start.getUTCDate() - 1);
  const since = start.toISOString();

  const [leads, queue, replies, qualified, meetings, optouts] = await Promise.all([
    db.from("crm_leads").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("source", "google_places").gte("created_at", since),
    db.from("prospecting_outbound_queue").select("kind,status").eq("organization_id", orgId).gte("created_at", since),
    db.from("messages").select("id, conversations!inner(metadata)", { count: "exact", head: true }).eq("organization_id", orgId).eq("direction", "inbound").gte("created_at", since).contains("conversations.metadata", { prospecting: true }),
    db.from("crm_leads").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("source", "google_places").contains("tags", ["qualificado"]),
    db.from("crm_leads").select("id, crm_stages!inner(name)", { count: "exact", head: true }).eq("organization_id", orgId).eq("source", "google_places").eq("crm_stages.name", "Reunião Agendada"),
    db.from("contacts").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("is_blocked", true).contains("tags", ["prospeccao"]),
  ]);
  const rows = queue.data ?? [];
  const openingsSent = rows.filter((r) => r.kind === "opening" && r.status === "sent").length;
  const followupsSent = rows.filter((r) => r.kind === "followup" && r.status === "sent").length;
  const failures = rows.filter((r) => r.status === "failed").length;
  const responseCount = replies.count ?? 0;

  return ok({
    leads_captured_today: leads.count ?? 0,
    leads_new: leads.count ?? 0,
    prospecting_messages_sent: openingsSent,
    replies_received: responseCount,
    response_rate: openingsSent > 0 ? responseCount / openingsSent : 0,
    qualified_leads: qualified.count ?? 0,
    meetings_scheduled: meetings.count ?? 0,
    followups_sent: followupsSent,
    opt_outs: optouts.count ?? 0,
    send_failures: failures,
    since,
  }, { requestId });
}

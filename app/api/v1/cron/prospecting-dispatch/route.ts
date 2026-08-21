import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { isWithinBusinessHours, loadProspectingConfig } from "@/lib/prospecting/config";
import { isAuthorizedProspectingCron } from "@/lib/prospecting/cron-auth";
import { claimOne, dispatchQueueRow } from "@/lib/prospecting/dispatch";
import { targetOrganizationId } from "@/lib/prospecting/service";

export const dynamic = "force-dynamic";

async function handle(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!isAuthorizedProspectingCron(request)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  const config = loadProspectingConfig();
  if (!config.enabled || !config.outboundEnabled) return ok({ skipped: true, reason: !config.enabled ? "prospecting_disabled" : "outbound_disabled", dry_run: config.dryRun }, { requestId });
  const db = createAdminClient() as unknown as SupabaseClient;
  const organizationId = await targetOrganizationId(db);

  if (config.dryRun) {
    const { data } = await db.from("prospecting_outbound_queue").select("id, kind, message_body, scheduled_for, metadata, contacts:contact_id(phone_number)")
      .eq("organization_id", organizationId).eq("status", "pending").lte("scheduled_for", new Date().toISOString())
      .order("scheduled_for").limit(config.dailyLimit);
    return ok({ dry_run: true, would_send: data ?? [] }, { requestId });
  }
  if (!isWithinBusinessHours(config)) return ok({ skipped: true, reason: "outside_business_hours", timezone: config.timezone }, { requestId });

  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { count } = await db.from("prospecting_outbound_queue").select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId).eq("status", "sent").gte("sent_at", since);
  if ((count ?? 0) >= config.dailyLimit) return ok({ skipped: true, reason: "daily_limit_reached", sent_last_24h: count, limit: config.dailyLimit }, { requestId });

  const row = await claimOne(db, organizationId);
  if (!row) return ok({ skipped: true, reason: "queue_empty" }, { requestId });
  const result = await dispatchQueueRow(db, row);
  return ok({ dry_run: false, result }, { requestId });
}

export async function GET(request: NextRequest) { return handle(request); }
export async function POST(request: NextRequest) { return handle(request); }

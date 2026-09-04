import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { activeCampaign, isWithinBusinessHours, loadProspectingConfig } from "@/lib/prospecting/config";
import { isAuthorizedProspectingCron } from "@/lib/prospecting/cron-auth";
import { dispatchProspectingCampaignOnConnection } from "@/lib/prospecting/auto-start";
import { targetOrganizationId } from "@/lib/prospecting/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!isAuthorizedProspectingCron(request)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  const config = loadProspectingConfig();
  if (!config.enabled || !config.outboundEnabled) return ok({ skipped: true, reason: !config.enabled ? "prospecting_disabled" : "outbound_disabled", dry_run: config.dryRun }, { requestId });
  const db = createAdminClient() as unknown as SupabaseClient;
  const organizationId = await targetOrganizationId(db);
  const campaign = activeCampaign();

  if (config.dryRun) {
    // Dry-run mostra SOMENTE o que seria enviado nesta campanha. Rows
    // arquivadas (campaign = "gb-osm-archive-2026-08" ou sem campaign) ficam
    // fora — são auditáveis mas inelegíveis para a campanha atual.
    let query = db
      .from("prospecting_outbound_queue")
      .select("id, kind, message_body, scheduled_for, metadata, contacts:contact_id(phone_number)")
      .eq("organization_id", organizationId)
      .eq("status", "pending")
      .lte("scheduled_for", new Date().toISOString())
      .order("scheduled_for")
      .limit(config.dailyLimit);
    if (campaign !== "") {
      query = query.eq("metadata->>campaign", campaign);
    }
    const { data } = await query;
    return ok(
      { dry_run: true, campaign, would_send: data ?? [] },
      { requestId },
    );
  }
  if (!isWithinBusinessHours(config)) return ok({ skipped: true, reason: "outside_business_hours", timezone: config.timezone }, { requestId });

  const result = await dispatchProspectingCampaignOnConnection(db, organizationId);
  return ok({ dry_run: false, campaign, result }, { requestId });
}

export async function GET(request: NextRequest) { return handle(request); }
export async function POST(request: NextRequest) { return handle(request); }

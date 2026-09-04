import type { SupabaseClient } from "@supabase/supabase-js";

import { activeCampaign, isWithinBusinessHours, loadProspectingConfig } from "./config";
import { claimOne, dispatchQueueRow, type DispatchResult } from "./dispatch";
import { targetOrganizationId } from "./service";

type ConnectionDispatch = DispatchResult | { outcome: "skipped"; reason: string };

export type ConnectionCampaignResult = {
  outcome: "completed" | "stopped" | "skipped";
  sent: number;
  cancelled: number;
  held: number;
  failed: number;
  reason?: string;
};

/**
 * Starts one safe prospecting dispatch when a WhatsApp session becomes WORKING.
 * The queue claim remains the concurrency/idempotency boundary; repeated WAHA
 * status events therefore cannot send the same row twice.
 */
export async function dispatchProspectingOnConnection(
  db: SupabaseClient,
  organizationId: string,
): Promise<ConnectionDispatch> {
  const config = loadProspectingConfig();
  if (!config.enabled) return { outcome: "skipped", reason: "prospecting_disabled" };
  if (!config.outboundEnabled) return { outcome: "skipped", reason: "outbound_disabled" };
  if (config.dryRun) return { outcome: "skipped", reason: "dry_run" };
  if (!isWithinBusinessHours(config)) return { outcome: "skipped", reason: "outside_business_hours" };

  const target = await targetOrganizationId(db);
  if (target !== organizationId) return { outcome: "skipped", reason: "organization_not_target" };

  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const { count } = await db
    .from("prospecting_outbound_queue")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("status", "sent")
    .gte("sent_at", since);
  if ((count ?? 0) >= config.dailyLimit) {
    return { outcome: "skipped", reason: "daily_limit_reached" };
  }

  const row = await claimOne(db, organizationId, activeCampaign() || null);
  if (!row) return { outcome: "skipped", reason: "queue_empty" };
  return dispatchQueueRow(db, row);
}

/**
 * Starts the daily opening campaign after a real WhatsApp reconnection.
 *
 * The daily limit counts only messages actually sent: a number without
 * WhatsApp is cancelled and the next lead is considered. A transport problem
 * stops the batch immediately, so an unhealthy WAHA session cannot consume
 * the rest of the prospecting queue.
 */
export async function dispatchProspectingCampaignOnConnection(
  db: SupabaseClient,
  organizationId: string,
): Promise<ConnectionCampaignResult> {
  const summary: ConnectionCampaignResult = {
    outcome: "completed",
    sent: 0,
    cancelled: 0,
    held: 0,
    failed: 0,
  };

  // Each single dispatch re-checks business hours and the daily limit. The
  // extra cap protects a malformed queue from holding a reconnect request
  // forever while still allowing enough non-WhatsApp numbers to be skipped.
  const maximumClaims = 100;
  for (let claimed = 0; claimed < maximumClaims; claimed += 1) {
    const result = await dispatchProspectingOnConnection(db, organizationId);
    if (result.outcome === "skipped") {
      summary.outcome = summary.sent > 0 || summary.cancelled > 0 ? "completed" : "skipped";
      summary.reason = result.reason;
      return summary;
    }

    if (result.outcome === "sent") {
      summary.sent += 1;
      continue;
    }
    if (result.outcome === "cancelled") {
      summary.cancelled += 1;
      continue;
    }
    if (result.outcome === "held") {
      summary.held += 1;
      summary.outcome = "stopped";
      summary.reason = result.reason;
      return summary;
    }

    summary.failed += 1;
    summary.outcome = "stopped";
    summary.reason = result.reason;
    return summary;
  }

  summary.outcome = "stopped";
  summary.reason = "campaign_claim_safety_cap";
  return summary;
}

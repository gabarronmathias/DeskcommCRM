import type { SupabaseClient } from "@supabase/supabase-js";

import { isWithinBusinessHours, loadProspectingConfig } from "./config";
import { claimOne, dispatchQueueRow, type DispatchResult } from "./dispatch";
import { targetOrganizationId } from "./service";

/**
 * Starts one safe prospecting dispatch when a WhatsApp session becomes WORKING.
 * The queue claim remains the concurrency/idempotency boundary; repeated WAHA
 * status events therefore cannot send the same row twice.
 */
export async function dispatchProspectingOnConnection(
  db: SupabaseClient,
  organizationId: string,
): Promise<DispatchResult | { outcome: "skipped"; reason: string }> {
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

  const row = await claimOne(db, organizationId);
  if (!row) return { outcome: "skipped", reason: "queue_empty" };
  return dispatchQueueRow(db, row);
}

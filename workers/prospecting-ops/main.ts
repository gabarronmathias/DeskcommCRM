import { setTimeout as sleep } from "node:timers/promises";

import type { SupabaseClient } from "@supabase/supabase-js";

import { dispatchProspectingOnConnection } from "@/lib/prospecting/auto-start";
import { activeCampaign, loadProspectingConfig } from "@/lib/prospecting/config";
import { searchFoodservicePlaces } from "@/lib/prospecting/google-places";
import { importProspect, targetOrganizationId } from "@/lib/prospecting/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient } from "@/lib/waha/client";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

function boolEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim().toLowerCase() === "true";
}

function log(level: "info" | "warn" | "error", message: string, meta: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, component: "prospecting-ops", message, ...meta });
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

async function emitEvent(
  db: SupabaseClient,
  organizationId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.rpc("emit_event", {
    p_event_type: eventType,
    p_entity_kind: "organization",
    p_entity_id: organizationId,
    p_payload: payload,
    p_metadata: { source: "prospecting-ops" },
    p_organization_id: organizationId,
  });
  if (error) log("warn", "event_log write failed", { eventType, error: error.message });
}

async function runDispatch(db: SupabaseClient, organizationId: string): Promise<void> {
  const startedAt = new Date().toISOString();
  try {
    const result = await dispatchProspectingOnConnection(db, organizationId);
    log("info", "dispatch tick", result as unknown as Record<string, unknown>);
    await emitEvent(db, organizationId, "prospecting.dispatch_tick", {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      campaign: activeCampaign(),
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", "dispatch tick failed", { error: message });
    await emitEvent(db, organizationId, "prospecting.dispatch_failed", {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      campaign: activeCampaign(),
      error: message.slice(0, 300),
    });
  }
}

let discoveryCursor = 0;

async function currentWorkingWahaSession(db: SupabaseClient, organizationId: string): Promise<string | null> {
  const { data } = await db
    .from("channel_sessions")
    .select("waha_session_name")
    .eq("organization_id", organizationId)
    .eq("provider", "waha")
    .eq("status", "WORKING")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const name = typeof data?.waha_session_name === "string" ? data.waha_session_name.trim() : "";
  return name || null;
}

async function runDiscovery(db: SupabaseClient, organizationId: string): Promise<void> {
  if (!boolEnv("HERMES_DISCOVERY_ENABLED", true)) return;

  const cfg = loadProspectingConfig();
  const campaign = activeCampaign();
  const startedAt = new Date().toISOString();

  if (!cfg.googlePlacesApiKey) {
    log("warn", "Hermes discovery blocked: GOOGLE_PLACES_API_KEY missing");
    await emitEvent(db, organizationId, "hermes.discovery_blocked", {
      started_at: startedAt,
      reason: "missing_google_places_api_key",
      campaign,
    });
    return;
  }

  const waha = getWahaClient();
  const session = await currentWorkingWahaSession(db, organizationId);
  if (!waha || !session) {
    log("warn", "Hermes discovery blocked: WAHA unavailable");
    await emitEvent(db, organizationId, "hermes.discovery_blocked", {
      started_at: startedAt,
      reason: "waha_unavailable",
      campaign,
    });
    return;
  }

  const cities = cfg.cities.length > 0 ? cfg.cities : ["São José dos Campos,SP"];
  const categories = cfg.categories.length > 0 ? cfg.categories : ["pizzaria", "hamburgueria", "padaria"];
  const combinations = cities.flatMap((city) => categories.map((category) => ({ city, category })));
  if (combinations.length === 0) return;

  const searches = intEnv("HERMES_SEARCHES_PER_RUN", 1, 1, 5);
  const importLimit = intEnv("HERMES_DISCOVERIES_PER_RUN", 5, 1, 20);
  let found = 0;
  let whatsappOk = 0;
  let noWhatsapp = 0;
  let created = 0;
  let duplicate = 0;
  let invalid = 0;
  let errors = 0;
  const queries: string[] = [];

  await emitEvent(db, organizationId, "hermes.discovery_started", {
    started_at: startedAt,
    campaign,
    searches,
    import_limit: importLimit,
  });

  for (let i = 0; i < searches && created < importLimit; i += 1) {
    const combo = combinations[discoveryCursor % combinations.length]!;
    discoveryCursor += 1;
    const cityName = combo.city.split(",")[0]?.trim() || combo.city;
    const query = `${combo.category} em ${cityName}`;
    queries.push(query);

    try {
      const candidates = await searchFoodservicePlaces({
        apiKey: cfg.googlePlacesApiKey,
        query,
        category: combo.category,
        fallbackCity: combo.city,
      });
      found += candidates.length;

      for (const candidate of candidates) {
        if (created >= importLimit) break;
        try {
          const check = await waha.checkPhoneExists(session, candidate.phoneRaw);
          if (!check.numberExists) {
            noWhatsapp += 1;
            continue;
          }
          whatsappOk += 1;
          const imported = await importProspect(db, candidate, { campaign });
          if (imported.outcome === "created") created += 1;
          else if (imported.outcome === "duplicate") duplicate += 1;
          else if (imported.outcome === "invalid") invalid += 1;
        } catch (error) {
          errors += 1;
          log("warn", "candidate validation/import failed", {
            company: candidate.companyName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      errors += 1;
      log("warn", "Google Places discovery query failed", {
        query,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    campaign,
    queries,
    found,
    whatsapp_ok: whatsappOk,
    no_whatsapp: noWhatsapp,
    created,
    duplicate,
    invalid,
    errors,
  };
  log("info", "Hermes discovery completed", report);
  await emitEvent(db, organizationId, "hermes.discovery_completed", report);
}

async function main(): Promise<void> {
  const db = createAdminClient();
  const organizationId = await targetOrganizationId(db);
  const dispatchEveryMs = intEnv("PROSPECTING_DISPATCH_INTERVAL_MINUTES", 15, 5, 120) * 60_000;
  const discoveryEveryMs = intEnv("HERMES_DISCOVERY_INTERVAL_MINUTES", 60, 15, 1440) * 60_000;

  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });

  log("info", "prospecting operations worker started", {
    organizationId,
    campaign: activeCampaign(),
    dispatchEveryMs,
    discoveryEveryMs,
  });

  let nextDispatchAt = 0;
  let nextDiscoveryAt = 0;

  while (!stopping) {
    const now = Date.now();
    if (now >= nextDispatchAt) {
      await runDispatch(db, organizationId);
      nextDispatchAt = Date.now() + dispatchEveryMs;
    }
    if (now >= nextDiscoveryAt) {
      await runDiscovery(db, organizationId);
      nextDiscoveryAt = Date.now() + discoveryEveryMs;
    }
    await sleep(5_000);
  }

  log("info", "prospecting operations worker stopped");
}

main().catch((error) => {
  log("error", "prospecting operations worker fatal", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

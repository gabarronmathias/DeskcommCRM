import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadProspectingConfig, OPENING_MESSAGE } from "@/lib/prospecting/config";
import { isAuthorizedProspectingCron } from "@/lib/prospecting/cron-auth";
import { searchFoodservicePlaces, type PublicBusinessProspect } from "@/lib/prospecting/google-places";
import { searchFoodserviceOpenStreetMap } from "@/lib/prospecting/openstreetmap";
import { importProspect } from "@/lib/prospecting/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!isAuthorizedProspectingCron(request)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  const config = loadProspectingConfig();
  if (!config.enabled) return ok({ skipped: true, reason: "prospecting_disabled", dry_run: config.dryRun }, { requestId });
  const unique = new Map<string, PublicBusinessProspect>();
  const errors: Array<{ query: string; error: string }> = [];

  const useGoogle = config.source === "google_places" || (config.source === "auto" && Boolean(config.googlePlacesApiKey));
  let searched = 0;
  if (useGoogle) {
    if (!config.googlePlacesApiKey) return fail("missing_configuration", "GOOGLE_PLACES_API_KEY ausente.", 503, { requestId });
    const pairs = config.cities.flatMap((city) => config.categories.map((category) => ({ city, category })));
    const day = Math.floor(Date.now() / 86_400_000);
    const selected = Array.from({ length: Math.min(config.searchesPerRun, pairs.length) }, (_, i) => pairs[(day * config.searchesPerRun + i) % pairs.length]!);
    searched = selected.length;
    for (const pair of selected) {
      const query = `${pair.category} em ${pair.city}`;
      try {
        const places = await searchFoodservicePlaces({ apiKey: config.googlePlacesApiKey, query, category: pair.category, fallbackCity: pair.city });
        for (const place of places) {
          if (!unique.has(`${place.source}:${place.sourceId}`)) unique.set(`${place.source}:${place.sourceId}`, place);
          if (unique.size >= config.dailyLimit) break;
        }
      } catch (error) {
        errors.push({ query, error: error instanceof Error ? error.message.slice(0, 240) : "unknown" });
      }
      if (unique.size >= config.dailyLimit) break;
    }
  } else {
    searched = 1;
    try {
      const places = await searchFoodserviceOpenStreetMap({
        cities: config.cities,
        limit: config.dailyLimit,
        bbox: config.overpassBbox,
        urls: config.overpassUrls,
        userAgent: config.overpassUserAgent,
      });
      for (const place of places) {
        unique.set(`${place.source}:${place.sourceId}`, place);
      }
    } catch (error) {
      errors.push({ query: "openstreetmap_overpass", error: error instanceof Error ? error.message.slice(0, 240) : "unknown" });
    }
  }

  const candidates = [...unique.values()].slice(0, config.dailyLimit);
  if (config.dryRun) {
    return ok({ dry_run: true, searched, candidates: candidates.map((p) => ({ company: p.companyName, phone: p.phoneRaw, category: p.category, city: p.city, source: p.source, source_url: p.sourceUrl, message: OPENING_MESSAGE(p.companyName) })), errors }, { requestId });
  }

  const db = createAdminClient() as unknown as SupabaseClient;
  const results = [];
  for (const candidate of candidates) results.push(await importProspect(db, candidate));
  return ok({ dry_run: false, searched, captured: candidates.length, created: results.filter((r) => r.outcome === "created").length, duplicates: results.filter((r) => r.outcome === "duplicate").length, invalid: results.filter((r) => r.outcome === "invalid").length, results, errors }, { requestId });
}

export async function GET(request: NextRequest) { return handle(request); }
export async function POST(request: NextRequest) { return handle(request); }

import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadProspectingConfig } from "@/lib/prospecting/config";
import { isAuthorizedProspectingCron } from "@/lib/prospecting/cron-auth";
import { searchFoodservicePlaces, type PublicBusinessProspect } from "@/lib/prospecting/google-places";
import { importProspect } from "@/lib/prospecting/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!isAuthorizedProspectingCron(request)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  const config = loadProspectingConfig();
  if (!config.enabled) return ok({ skipped: true, reason: "prospecting_disabled", dry_run: config.dryRun }, { requestId });
  if (!config.googlePlacesApiKey) return fail("missing_configuration", "GOOGLE_PLACES_API_KEY ausente.", 503, { requestId });

  const pairs = config.cities.flatMap((city) => config.categories.map((category) => ({ city, category })));
  const day = Math.floor(Date.now() / 86_400_000);
  const selected = Array.from({ length: Math.min(config.searchesPerRun, pairs.length) }, (_, i) => pairs[(day * config.searchesPerRun + i) % pairs.length]!);
  const unique = new Map<string, PublicBusinessProspect>();
  const errors: Array<{ query: string; error: string }> = [];

  for (const pair of selected) {
    const query = `${pair.category} em ${pair.city}`;
    try {
      const places = await searchFoodservicePlaces({ apiKey: config.googlePlacesApiKey, query, category: pair.category, fallbackCity: pair.city });
      for (const place of places) {
        if (!unique.has(place.placeId)) unique.set(place.placeId, place);
        if (unique.size >= config.dailyLimit) break;
      }
    } catch (error) {
      errors.push({ query, error: error instanceof Error ? error.message.slice(0, 240) : "unknown" });
    }
    if (unique.size >= config.dailyLimit) break;
  }

  const candidates = [...unique.values()].slice(0, config.dailyLimit);
  if (config.dryRun) {
    return ok({ dry_run: true, searched: selected.length, candidates: candidates.map((p) => ({ company: p.companyName, phone: p.phoneRaw, category: p.category, city: p.city, source: "google_places", message: `Abertura personalizada para ${p.companyName}` })), errors }, { requestId });
  }

  const db = createAdminClient() as unknown as SupabaseClient;
  const results = [];
  for (const candidate of candidates) results.push(await importProspect(db, candidate));
  return ok({ dry_run: false, searched: selected.length, captured: candidates.length, created: results.filter((r) => r.outcome === "created").length, duplicates: results.filter((r) => r.outcome === "duplicate").length, invalid: results.filter((r) => r.outcome === "invalid").length, results, errors }, { requestId });
}

export async function GET(request: NextRequest) { return handle(request); }
export async function POST(request: NextRequest) { return handle(request); }

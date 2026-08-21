import { OPENING_MESSAGE, loadProspectingConfig } from "@/lib/prospecting/config";
import { normalizeBrazilianCommercialPhone } from "@/lib/prospecting/normalization";
import { searchFoodserviceOpenStreetMap } from "@/lib/prospecting/openstreetmap";

async function main() {
  const config = loadProspectingConfig();
  const collected = await searchFoodserviceOpenStreetMap({
    cities: config.cities,
    limit: Math.min(config.dailyLimit * 4, 100),
    bbox: config.overpassBbox,
    urls: config.overpassUrls,
    userAgent: config.overpassUserAgent,
  });
  const seenPhones = new Set<string>();
  const candidates = collected.flatMap((prospect) => {
    const phone = normalizeBrazilianCommercialPhone(prospect.phoneRaw);
    if (!phone || seenPhones.has(phone)) return [];
    seenPhones.add(phone);
    return [{
      company: prospect.companyName,
      phone,
      category: prospect.category,
      city: prospect.city,
      source: prospect.source,
      source_url: prospect.sourceUrl,
      message: OPENING_MESSAGE(prospect.companyName),
    }];
  }).slice(0, config.dailyLimit);

  process.stdout.write(`${JSON.stringify({ dry_run: true, count: candidates.length, candidates }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "prospecting_dry_run_failed"}\n`);
  process.exitCode = 1;
});

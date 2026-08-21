import type { PublicBusinessProspect } from "./google-places";

const DEFAULT_OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const TARGET_CITY_CENTERS: Record<string, { lat: number; lon: number }> = {
  "sao jose dos campos": { lat: -23.2237, lon: -45.9009 },
  jacarei: { lat: -23.3053, lon: -45.9658 },
  cacapava: { lat: -23.1008, lon: -45.7066 },
  taubate: { lat: -23.0205, lon: -45.5568 },
  pindamonhangaba: { lat: -22.9248, lon: -45.4613 },
};

interface OverpassElement {
  type?: "node" | "way" | "relation";
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function phoneOf(tags: Record<string, string>): string | null {
  return tags["contact:whatsapp"] ?? tags.whatsapp ?? tags["contact:mobile"]
    ?? tags.mobile ?? tags["contact:phone"] ?? tags.phone ?? null;
}

function websiteOf(tags: Record<string, string>): string | null {
  return tags["contact:website"] ?? tags.website ?? null;
}

function categoryOf(tags: Record<string, string>): string {
  const cuisine = normalized(tags.cuisine ?? "");
  if (cuisine.includes("pizza")) return "pizzaria";
  if (cuisine.includes("burger")) return "hamburgueria";
  if (cuisine.includes("sushi") || cuisine.includes("japanese")) return "restaurante japonês sushi";
  if (cuisine.includes("acai")) return "açaí";
  const shop = tags.shop;
  if (shop === "bakery") return "padaria";
  if (shop === "confectionery" || shop === "pastry") return "confeitaria";
  const amenity = tags.amenity;
  if (amenity === "cafe") return "cafeteria";
  if (amenity === "bar" || amenity === "pub") return "choperia";
  if (amenity === "fast_food") return "lanchonete";
  return "restaurante delivery";
}

function addressOf(tags: Record<string, string>): string {
  return [tags["addr:street"], tags["addr:housenumber"], tags["addr:suburb"], tags["addr:city"]]
    .filter(Boolean).join(", ");
}

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function resolveCity(tags: Record<string, string>, point: { lat: number; lon: number }, configured: string[]): string | null {
  const allowed = new Map(configured.map((city) => [normalized(city.split(",")[0] ?? city), city.split(",")[0]!.trim()]));
  const tagged = normalized(tags["addr:city"] ?? tags["addr:municipality"] ?? "");
  if (tagged) return allowed.get(tagged) ?? null;

  let nearest: { city: string; distance: number } | null = null;
  for (const [key, display] of allowed) {
    const center = TARGET_CITY_CENTERS[key];
    if (!center) continue;
    const distance = distanceKm(point, center);
    if (!nearest || distance < nearest.distance) nearest = { city: display, distance };
  }
  return nearest && nearest.distance <= 25 ? nearest.city : null;
}

function buildQuery(bbox: string, limit: number): string {
  const amenity = "^(restaurant|fast_food|cafe|bar|pub|food_court|ice_cream)$";
  const shop = "^(bakery|confectionery|deli|pastry|food)$";
  const selectors = [
    `[\"amenity\"~\"${amenity}\"]`,
    `[\"shop\"~\"${shop}\"]`,
  ].flatMap((kind) => ["phone", "contact:phone", "mobile", "contact:mobile", "whatsapp", "contact:whatsapp"]
    .map((phone) => `nwr(${bbox})[\"name\"]${kind}[\"${phone}\"];`)).join("");
  return `[out:json][timeout:40];(${selectors});out center tags qt ${Math.max(limit * 8, 100)};`;
}

export async function searchFoodserviceOpenStreetMap(input: {
  cities: string[];
  limit: number;
  bbox: string;
  urls?: string[];
  userAgent?: string;
  signal?: AbortSignal;
}): Promise<PublicBusinessProspect[]> {
  const query = buildQuery(input.bbox, input.limit);
  const urls = input.urls?.length ? input.urls : DEFAULT_OVERPASS_URLS;
  let lastError = "overpass_unavailable";
  for (const url of urls) {
    try {
      const body = new URLSearchParams({ data: query });
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": input.userAgent ?? "DeskcommCRM/1.0 (+https://deskcomm-crm-mu.vercel.app)",
        },
        body,
        signal: input.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        lastError = `overpass_${response.status}: ${(await response.text()).slice(0, 160)}`;
        continue;
      }
      const payload = (await response.json()) as { elements?: OverpassElement[] };
      const unique = new Map<string, PublicBusinessProspect>();
      for (const element of payload.elements ?? []) {
        const tags = element.tags ?? {};
        const point = {
          lat: element.lat ?? element.center?.lat,
          lon: element.lon ?? element.center?.lon,
        };
        if (!element.type || !element.id || point.lat === undefined || point.lon === undefined) continue;
        const city = resolveCity(tags, { lat: point.lat, lon: point.lon }, input.cities);
        const phoneRaw = phoneOf(tags)?.trim();
        const companyName = tags.name?.trim();
        if (!city || !phoneRaw || !companyName || tags.disused || tags.abandoned || tags.closed === "yes" || tags.access === "private") continue;
        const sourceId = `${element.type}/${element.id}`;
        const sourceUrl = `https://www.openstreetmap.org/${sourceId}`;
        unique.set(sourceId, {
          source: "openstreetmap",
          sourceId,
          sourceUrl,
          placeId: `osm:${sourceId}`,
          companyName,
          category: categoryOf(tags),
          phoneRaw,
          website: websiteOf(tags)?.trim() || null,
          address: addressOf(tags),
          neighborhood: tags["addr:suburb"]?.trim() || null,
          city,
          state: "SP",
          mapsUrl: sourceUrl,
          rating: null,
          reviewCount: null,
          businessStatus: "OPERATIONAL",
          primaryType: tags.amenity ?? tags.shop ?? null,
          types: [tags.amenity, tags.shop, tags.cuisine].filter((value): value is string => Boolean(value)),
        });
        if (unique.size >= input.limit) break;
      }
      return [...unique.values()];
    } catch (error) {
      lastError = error instanceof Error ? error.message : "overpass_unknown";
    }
  }
  throw new Error(lastError);
}

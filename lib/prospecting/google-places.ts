const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.businessStatus",
  "places.primaryType",
  "places.types",
  "places.rating",
  "places.userRatingCount",
].join(",");

interface AddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface GooglePlaceRaw {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: AddressComponent[];
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  businessStatus?: string;
  primaryType?: string;
  types?: string[];
  rating?: number;
  userRatingCount?: number;
}

export interface PublicBusinessProspect {
  placeId: string;
  companyName: string;
  category: string;
  phoneRaw: string;
  website: string | null;
  address: string;
  neighborhood: string | null;
  city: string;
  state: string;
  mapsUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  businessStatus: string;
  primaryType: string | null;
  types: string[];
}

function addressPart(parts: AddressComponent[] | undefined, type: string, short = false): string | null {
  const part = parts?.find((p) => p.types?.includes(type));
  return (short ? part?.shortText : part?.longText)?.trim() || null;
}

export async function searchFoodservicePlaces(input: {
  apiKey: string;
  query: string;
  category: string;
  fallbackCity: string;
  signal?: AbortSignal;
}): Promise<PublicBusinessProspect[]> {
  const response = await fetch(TEXT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": input.apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: input.query, languageCode: "pt-BR", regionCode: "BR", pageSize: 20 }),
    signal: input.signal,
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`google_places_${response.status}: ${detail}`);
  }
  const payload = (await response.json()) as { places?: GooglePlaceRaw[] };
  return (payload.places ?? []).flatMap((place) => {
    const placeId = place.id?.trim();
    const companyName = place.displayName?.text?.trim();
    const phoneRaw = (place.internationalPhoneNumber ?? place.nationalPhoneNumber)?.trim();
    if (!placeId || !companyName || !phoneRaw || place.businessStatus !== "OPERATIONAL") return [];
    return [{
      placeId,
      companyName,
      category: input.category,
      phoneRaw,
      website: place.websiteUri?.trim() || null,
      address: place.formattedAddress?.trim() || "",
      neighborhood: addressPart(place.addressComponents, "sublocality_level_1") ?? addressPart(place.addressComponents, "neighborhood"),
      city: addressPart(place.addressComponents, "administrative_area_level_2") ?? input.fallbackCity.split(",")[0]!.trim(),
      state: addressPart(place.addressComponents, "administrative_area_level_1", true) ?? input.fallbackCity.split(",")[1]?.trim() ?? "SP",
      mapsUrl: place.googleMapsUri?.trim() || null,
      rating: typeof place.rating === "number" ? place.rating : null,
      reviewCount: typeof place.userRatingCount === "number" ? place.userRatingCount : null,
      businessStatus: place.businessStatus,
      primaryType: place.primaryType?.trim() || null,
      types: place.types ?? [],
    }];
  });
}

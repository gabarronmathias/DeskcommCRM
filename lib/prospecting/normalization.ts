export function normalizeBrazilianCommercialPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const withCountry = digits.startsWith("55") && (digits.length === 12 || digits.length === 13)
    ? digits
    : digits.length === 10 || digits.length === 11
      ? `55${digits}`
      : digits;
  return withCountry.length >= 10 && withCountry.length <= 15 ? `+${withCountry}` : null;
}

export function domainOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function segmentTag(category: string): string {
  const normalized = category.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (normalized.includes("japones") || normalized.includes("sushi")) return "japones";
  if (normalized.includes("dark kitchen")) return "delivery";
  return normalized.split(/\s+/)[0]!.replace(/[^a-z0-9_-]/g, "") || "foodservice";
}

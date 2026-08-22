export const TARGET_ORG_SLUG = "gabarron-mathias";
export const TARGET_PIPELINE_NAME = "Oportunidades Comerciais";
export const NEW_STAGE_NAME = "Novo Lead";
export const SARAH_STAGE_NAME = "Sarah Atendendo";
export const FOLLOWUP_FLOW_NAME = "Follow-up prospecção 48h";

export const OPENING_MESSAGE = (company: string) =>
  `Olá! Tudo bem? Sou a Sarah, da Gabarron & Mathias. Vi a ${company} e queria me apresentar: somos especialistas em atendimento para delivery e ajudamos negócios de alimentação a vender mais, recuperar oportunidades e trazer clientes de volta pelo WhatsApp. Como vocês organizam o atendimento por aí hoje?`;

export const SARAH_POSITIONING =
  "Nós ajudamos padarias, restaurantes, pizzarias, hamburguerias, esfiharias e deliveries a transformar o WhatsApp e a própria base de clientes em uma máquina de vendas recorrentes.";

export const FOLLOWUP_MESSAGE =
  `Oi! Passando só para não deixar minha mensagem perdida por aqui.\n\n${SARAH_POSITIONING}\n\nA Sarah é uma agente de relacionamento e vendas que atua em cinco frentes: aumenta o ticket durante o pedido, recupera vendas não concluídas, faz follow-up automaticamente, reativa clientes que pararam de comprar e cria campanhas para trazer a base de volta.\n\nNa prática, ela ajuda o delivery a vender mais, perder menos oportunidades e aumentar a frequência de compra, sem depender de o atendente lembrar de fazer tudo manualmente.\n\nSe fizer sentido para vocês, eu consigo te mostrar rapidamente como isso funcionaria na prática.`;

const DEFAULT_CITIES = [
  "São José dos Campos,SP",
  "Jacareí,SP",
  "Caçapava,SP",
  "Taubaté,SP",
  "Pindamonhangaba,SP",
];

const DEFAULT_CATEGORIES = [
  "padaria",
  "restaurante delivery",
  "pizzaria",
  "esfiharia",
  "hamburgueria",
  "lanchonete",
  "marmitaria",
  "açaí",
  "restaurante japonês sushi",
  "choperia",
  "confeitaria",
  "cafeteria",
  "casa de salgados",
  "dark kitchen delivery",
];

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function list(value: string | undefined, fallback: string[]): string[] {
  const parsed = (value ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  return parsed.length > 0 ? [...new Set(parsed)] : fallback;
}

export interface ProspectingConfig {
  source: "auto" | "google_places" | "openstreetmap";
  googlePlacesApiKey: string;
  overpassUrls: string[];
  overpassBbox: string;
  overpassUserAgent: string;
  enabled: boolean;
  outboundEnabled: boolean;
  dryRun: boolean;
  dailyLimit: number;
  cities: string[];
  categories: string[];
  timezone: string;
  businessHourStart: number;
  businessHourEnd: number;
  searchesPerRun: number;
}

export function loadProspectingConfig(): ProspectingConfig {
  const sourceRaw = (process.env.PROSPECTING_SOURCE ?? "auto").trim().toLowerCase();
  return {
    source: sourceRaw === "google_places" || sourceRaw === "openstreetmap" ? sourceRaw : "auto",
    googlePlacesApiKey: (process.env.GOOGLE_PLACES_API_KEY ?? "").trim(),
    overpassUrls: list(process.env.PROSPECTING_OVERPASS_URLS, [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
    ]),
    overpassBbox: (process.env.PROSPECTING_OVERPASS_BBOX ?? "-23.45,-46.20,-22.65,-45.30").trim(),
    overpassUserAgent: (
      process.env.PROSPECTING_OVERPASS_USER_AGENT ?? "GMProspecting/1.0 (tenant: gabarron-mathias)"
    ).trim(),
    enabled: bool(process.env.PROSPECTING_ENABLED, false),
    outboundEnabled: bool(process.env.OUTBOUND_ENABLED, false),
    dryRun: bool(process.env.PROSPECTING_DRY_RUN, true),
    dailyLimit: integer(process.env.PROSPECTING_DAILY_LIMIT, 20, 1, 100),
    cities: list(process.env.PROSPECTING_CITIES, DEFAULT_CITIES),
    categories: list(process.env.PROSPECTING_CATEGORIES, DEFAULT_CATEGORIES),
    timezone: (process.env.PROSPECTING_TIMEZONE ?? "America/Sao_Paulo").trim(),
    businessHourStart: integer(process.env.PROSPECTING_BUSINESS_HOUR_START, 9, 0, 23),
    businessHourEnd: integer(process.env.PROSPECTING_BUSINESS_HOUR_END, 18, 1, 24),
    searchesPerRun: integer(process.env.PROSPECTING_SEARCHES_PER_RUN, 5, 1, 20),
  };
}

export function isWithinBusinessHours(config: ProspectingConfig, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "-1");
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  // Foodservice operates Monday through Saturday. Delivery operations often
  // run later on Friday, so keep the ordinary end hour for every other day
  // with a narrowly scoped Friday override.
  const fridayEnd = integer(process.env.PROSPECTING_FRIDAY_BUSINESS_HOUR_END, 19, 1, 24);
  const end = weekday === "Fri" ? Math.max(config.businessHourEnd, fridayEnd) : config.businessHourEnd;
  return (
    weekday !== "Sun" &&
    hour >= config.businessHourStart &&
    hour < end
  );
}

export type DeliveryPolicy = {
  timezone: "America/Sao_Paulo";
  threshold_cents: number;
  up_to_threshold_fee_cents: number;
  weekday_before_cutoff_fee_cents: number;
  weekday_from_cutoff_fee_cents: number;
  weekend_fee_cents: number;
  cutoff_local_time: string;
  blocked_neighborhoods: string[];
};

export type DeliveryQuote =
  | { eligible: true; fee_cents: number }
  | { eligible: false; fee_cents: 0; reason: "outside_service_area" | "blocked_neighborhood" | "location_required" };

export function normalizeDeliveryArea(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toLocaleLowerCase("pt-BR").replace(/\s+/g, " ");
}

/** Lê apenas valores explícitos das orientações salvas; não inventa uma lista. */
export function deliverySettingsFromSarahRules(rules: string, serviceAreas: readonly string[]): {
  policy: DeliveryPolicy;
  service_areas: string[];
} | null {
  const threshold = rules.match(/Pedidos\s+(?:de\s+)?at[eé]\s*R\$\s*([\d.,]+)[^\n]*?R\$\s*([\d.,]+)/i);
  const weekdayBefore = rules.match(/Pedidos acima de R\$\s*[\d.,]+, de segunda a sexta-feira antes d(?:a|as)\s*(\d{1,2})(?::00)?h?[^\n]*?taxa de entrega de R\$\s*([\d.,]+)/i);
  const weekdayAfter = rules.match(/Pedidos acima de R\$\s*[\d.,]+, de segunda a sexta-feira a partir d(?:a|as)\s*(\d{1,2})(?::00)?h?[^\n]*?entrega gr[aá]tis/i);
  const weekend = rules.match(/Aos s[aá]bados e domingos, pedidos acima de R\$\s*[\d.,]+[^\n]*entrega gr[aá]tis/i);
  const blockedSection = rules.match(/(?:REGI[ÕO]ES|BAIRROS) N[ÃA]O ATENDID[OA]S:\s*([\s\S]*)/i)?.[1];
  const blockedListParagraph = blockedSection
    ?.split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .find((paragraph) => paragraph.includes(";"));
  if (!threshold || !weekdayBefore || !weekdayAfter || !weekend || !blockedListParagraph || serviceAreas.length === 0) return null;
  const cents = (value: string) => Math.round(Number(value.replace(/\./g, "").replace(",", ".")) * 100);
  const cutoffHour = Number(weekdayBefore[1]);
  if (cutoffHour !== Number(weekdayAfter[1])) return null;
  const blockedNeighborhoods = blockedListParagraph
    .replace(/\s*\r?\n\s*/g, " ")
    .split(";")
    .map((item) => item.trim().replace(/[.,]+$/, ""))
    .filter(Boolean);
  if (!blockedNeighborhoods.length) return null;

  return {
    policy: {
      timezone: "America/Sao_Paulo",
      threshold_cents: cents(threshold[1]!),
      up_to_threshold_fee_cents: cents(threshold[2]!),
      weekday_before_cutoff_fee_cents: cents(weekdayBefore[2]!),
      weekday_from_cutoff_fee_cents: 0,
      weekend_fee_cents: 0,
      cutoff_local_time: `${String(cutoffHour).padStart(2, "0")}:00`,
      blocked_neighborhoods: blockedNeighborhoods,
    },
    service_areas: [...serviceAreas],
  };
}

export function quoteDelivery(input: {
  policy: DeliveryPolicy;
  serviceAreas: readonly string[];
  subtotalCents: number;
  city: string;
  neighborhood: string;
  at: Date;
}): DeliveryQuote {
  const city = normalizeDeliveryArea(input.city);
  const neighborhood = normalizeDeliveryArea(input.neighborhood);
  if (!city || !neighborhood) return { eligible: false, fee_cents: 0, reason: "location_required" };
  if (!input.serviceAreas.some((area) => normalizeDeliveryArea(area) === city)) {
    return { eligible: false, fee_cents: 0, reason: "outside_service_area" };
  }
  if (input.policy.blocked_neighborhoods.some((area) => normalizeDeliveryArea(area) === neighborhood)) {
    return { eligible: false, fee_cents: 0, reason: "blocked_neighborhood" };
  }

  if (input.subtotalCents <= input.policy.threshold_cents) {
    return { eligible: true, fee_cents: input.policy.up_to_threshold_fee_cents };
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.policy.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(input.at);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  if (isWeekend) return { eligible: true, fee_cents: input.policy.weekend_fee_cents };
  const [cutoffHour, cutoffMinute] = input.policy.cutoff_local_time.split(":").map(Number);
  const atOrAfterCutoff = hour > cutoffHour! || (hour === cutoffHour && minute >= cutoffMinute!);
  return {
    eligible: true,
    fee_cents: atOrAfterCutoff
      ? input.policy.weekday_from_cutoff_fee_cents
      : input.policy.weekday_before_cutoff_fee_cents,
  };
}


/** Sincroniza a regra legível da Sarah com a política usada pelo checkout. */
export function synchronizeDeliveryPolicy(
  operation: Record<string, unknown>,
  rules: string,
): Record<string, unknown> {
  const serviceAreas = Array.isArray(operation.service_areas)
    ? operation.service_areas.filter((area): area is string => typeof area === "string")
    : [];
  const parsed = deliverySettingsFromSarahRules(rules, serviceAreas);
  const next = { ...operation };

  if (operation.delivery_enabled === true) {
    next.delivery_policy_required = true;
    next.minimum_order_cents = 0;
    if (parsed) {
      next.delivery_policy = parsed.policy;
      next.service_areas = parsed.service_areas;
    } else {
      // Sem uma regra interpretável, o checkout deve recusar entrega.
      delete next.delivery_policy;
    }
  }

  return next;
}

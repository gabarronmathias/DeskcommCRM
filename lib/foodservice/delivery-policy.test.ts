import { describe, expect, it } from "vitest";
import { deliverySettingsFromSarahRules, quoteDelivery, type DeliveryPolicy } from "./delivery-policy";

const policy: DeliveryPolicy = {
  timezone: "America/Sao_Paulo",
  threshold_cents: 10_000,
  up_to_threshold_fee_cents: 1_000,
  weekday_before_cutoff_fee_cents: 500,
  weekday_from_cutoff_fee_cents: 0,
  weekend_fee_cents: 0,
  cutoff_local_time: "19:00",
  blocked_neighborhoods: ["Rio Cumprido", "Cidade Salvador"],
};
const quote = (subtotalCents: number, at: string, city = "Jacareí", neighborhood = "Centro") =>
  quoteDelivery({ policy, serviceAreas: ["jacaréi"], subtotalCents, city, neighborhood, at: new Date(at) });

describe("política de entrega foodservice", () => {
  it("cobra R$10 até R$100 inclusive", () => {
    expect(quote(10_000, "2026-11-27T21:00:00Z")).toEqual({ eligible: true, fee_cents: 1_000 });
  });

  it("cobra R$5 acima de R$100 em dia útil antes das 19h local", () => {
    expect(quote(10_001, "2026-11-27T21:59:00Z")).toEqual({ eligible: true, fee_cents: 500 });
  });

  it("dá frete grátis às 19h e depois em dia útil", () => {
    expect(quote(10_001, "2026-11-27T22:00:00Z")).toEqual({ eligible: true, fee_cents: 0 });
  });

  it.each([
    ["sexta antes do corte", "2026-11-27T21:59:00Z", 500],
    ["sábado", "2026-11-28T15:00:00Z", 0],
    ["domingo", "2026-11-29T15:00:00Z", 0],
  ])("aplica o calendário: %s", (_label, at, fee) => {
    expect(quote(10_001, at as string)).toEqual({ eligible: true, fee_cents: fee });
  });

  it("bloqueia bairro não atendido e cidade fora da cobertura, ignorando acentos", () => {
    expect(quote(20_000, "2026-11-27T18:00:00-03:00", "Jacarei", "RIO CUMPRIDO"))
      .toEqual({ eligible: false, fee_cents: 0, reason: "blocked_neighborhood" });
    expect(quote(20_000, "2026-11-27T18:00:00-03:00", "São José dos Campos", "Centro"))
      .toEqual({ eligible: false, fee_cents: 0, reason: "outside_service_area" });
  });

  it("transforma as regras e bairros existentes da Sarah em configuração explícita", () => {
    const settings = deliverySettingsFromSarahRules(`
      TAXA DE ENTREGA:
      Pedidos de até R$ 100,00: taxa de entrega de R$ 10,00.
      Pedidos acima de R$ 100,00, de segunda a sexta-feira antes das 19h: taxa de entrega de R$ 5,00.
      Pedidos acima de R$ 100,00, de segunda a sexta-feira a partir das 19h: entrega grátis.
      Aos sábados e domingos, pedidos acima de R$ 100,00: entrega grátis.

      REGIÕES NÃO ATENDIDAS:

      Rio Cumprido; Cidade Salvador; Príncipes.

    `, ["Jacareí"]);
    expect(settings?.policy).toMatchObject({ threshold_cents: 10_000, up_to_threshold_fee_cents: 1_000,
      weekday_before_cutoff_fee_cents: 500, weekday_from_cutoff_fee_cents: 0, weekend_fee_cents: 0,
      cutoff_local_time: "19:00", blocked_neighborhoods: ["Rio Cumprido", "Cidade Salvador", "Príncipes"] });
    expect(settings?.service_areas).toEqual(["Jacareí"]);
  });
});

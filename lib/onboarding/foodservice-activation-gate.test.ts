import { describe, expect, it } from "vitest";

import { foodserviceActivationPending, foodserviceSetupExists } from "./foodservice-activation-gate";

describe("gate canônico da implantação Foodservice", () => {
  it("não interfere em organizações que não usam o onboarding Foodservice", () => {
    expect(foodserviceSetupExists({ welcome: { accepted_at: "2026-01-01" } })).toBe(false);
    expect(foodserviceActivationPending({ welcome: { accepted_at: "2026-01-01" } })).toBe(false);
  });

  it("mantém a implantação pendente até o estado ACTIVE", () => {
    expect(foodserviceActivationPending({ foodservice_setup: { status: "DRAFT" } })).toBe(true);
    expect(foodserviceActivationPending({ foodservice_setup: { status: "ACTIVE" } })).toBe(false);
  });

  it("falha fechado se existir setup sem status válido", () => {
    expect(foodserviceActivationPending({ foodservice_setup: { company: {} } })).toBe(true);
  });
});

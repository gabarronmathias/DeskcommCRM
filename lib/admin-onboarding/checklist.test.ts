import { describe, expect, it } from "vitest";
import { buildOnboardingChecklist, missingOnboardingRequirements } from "./checklist";

const ready = {
  company: true, operation: true, sarah: true, catalog: true,
  operator: true, whatsapp: true, oms: true, handoff: true,
};

describe("checklist de ativação do onboarding", () => {
  it("mostra os nove critérios e libera somente quando todos passaram", () => {
    const checklist = buildOnboardingChecklist({ ...ready, omsTested: true, handoffTested: true });
    expect(checklist).toHaveLength(9);
    expect(missingOnboardingRequirements(checklist)).toEqual([]);
  });

  it("mantém pendentes a memória sem publicação e a conexão Meta real", () => {
    const checklist = buildOnboardingChecklist({ ...ready, sarah: false, whatsapp: false });
    expect(missingOnboardingRequirements(checklist)).toEqual([
      "Sarah configurada e publicada",
      "WhatsApp Meta conectado",
      "OMS disponível — homologação operacional pendente",
      "Handoff disponível — homologação operacional pendente",
    ]);
  });

  it("não apresenta OMS e handoff como homologados quando só estão disponíveis", () => {
    const checklist = buildOnboardingChecklist(ready);
    const oms = checklist.find((item) => item.key === "oms");
    const handoff = checklist.find((item) => item.key === "handoff");
    expect(oms).toMatchObject({ status: "available", pass: false, activationReady: false });
    expect(handoff).toMatchObject({ status: "available", pass: false, activationReady: false });
    expect(missingOnboardingRequirements(checklist)).toEqual([
      "OMS disponível — homologação operacional pendente",
      "Handoff disponível — homologação operacional pendente",
    ]);
  });

  it("exige evidência de teste para marcar OMS e handoff como homologados", () => {
    const checklist = buildOnboardingChecklist({ ...ready, omsTested: true, handoffTested: true });
    expect(checklist.find((item) => item.key === "oms")).toMatchObject({
      status: "tested", pass: true, activationReady: true,
    });
    expect(checklist.find((item) => item.key === "handoff")).toMatchObject({
      status: "tested", pass: true, activationReady: true,
    });
  });

  it("não libera entrega sem política estruturada salva", async () => {
    const { operationSchema } = await import("./schema");
    const operation = {
      business_days: ["mon"], opens_at: "11:30", closes_at: "23:00",
      delivery_enabled: true, delivery_policy_required: true, pickup_enabled: true, service_areas: ["Jacareí"],
      delivery_fee_cents: 1000, minimum_order_cents: 0, average_prep_minutes: 30,
      payment_methods: ["pix"],
    };
    expect(operationSchema.safeParse(operation).success).toBe(false);
    expect(operationSchema.safeParse({
      ...operation,
      delivery_policy: {
        timezone: "America/Sao_Paulo", threshold_cents: 10_000,
        up_to_threshold_fee_cents: 1_000, weekday_before_cutoff_fee_cents: 500,
        weekday_from_cutoff_fee_cents: 0, weekend_fee_cents: 0,
        cutoff_local_time: "19:00", blocked_neighborhoods: [],
      },
    }).success).toBe(true);
    expect(operationSchema.safeParse({ ...operation, delivery_policy_required: false }).success).toBe(true);
  });
});

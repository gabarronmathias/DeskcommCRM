import { describe, expect, it } from "vitest";
import { buildOnboardingChecklist, missingOnboardingRequirements } from "./checklist";

const ready = {
  company: true, operation: true, sarah: true, catalog: true,
  operator: true, whatsapp: true, oms: true, handoff: true,
};

describe("checklist de ativação do onboarding", () => {
  it("mostra os nove critérios e libera somente quando todos passaram", () => {
    const checklist = buildOnboardingChecklist(ready);
    expect(checklist).toHaveLength(9);
    expect(missingOnboardingRequirements(checklist)).toEqual([]);
  });

  it("mantém pendentes a memória sem publicação e a conexão Meta real", () => {
    const checklist = buildOnboardingChecklist({ ...ready, sarah: false, whatsapp: false });
    expect(missingOnboardingRequirements(checklist)).toEqual([
      "Sarah configurada e publicada",
      "WhatsApp Meta conectado",
    ]);
  });
});

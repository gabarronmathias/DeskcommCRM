export type OnboardingChecklistKey =
  | "company" | "operation" | "sarah" | "catalog" | "operator"
  | "whatsapp" | "cart" | "oms" | "handoff";

export type OnboardingChecklistItem = {
  key: OnboardingChecklistKey;
  label: string;
  status: "pass" | "configured" | "available" | "tested" | "pending";
  pass: boolean;
  activationReady: boolean;
};

export type OnboardingChecklistFacts = {
  company: boolean;
  operation: boolean;
  sarah: boolean;
  catalog: boolean;
  operator: boolean;
  whatsapp: boolean;
  oms: boolean;
  omsTested?: boolean;
  handoff: boolean;
  handoffTested?: boolean;
};

export function buildOnboardingChecklist(facts: OnboardingChecklistFacts): OnboardingChecklistItem[] {
  const item = (
    key: OnboardingChecklistKey,
    label: string,
    ready: boolean,
    status: OnboardingChecklistItem["status"] = ready ? "pass" : "pending",
    activationReady = ready,
  ): OnboardingChecklistItem => ({ key, label, status, pass: status === "pass" || status === "tested", activationReady });

  return [
    item("company", "Empresa configurada", facts.company),
    item("operation", "Operação configurada", facts.operation),
    item("sarah", "Sarah configurada e publicada", facts.sarah),
    item("catalog", "Catálogo disponível", facts.catalog),
    item("operator", "Operador associado e convite aceito", facts.operator),
    item("whatsapp", "WhatsApp Meta conectado", facts.whatsapp),
    item("cart", "Carrinho disponível", facts.catalog),
    item(
      "oms",
      facts.omsTested ? "OMS homologado" : "OMS disponível — homologação operacional pendente",
      facts.oms,
      facts.omsTested ? "tested" : facts.oms ? "available" : "pending",
      facts.omsTested === true,
    ),
    item(
      "handoff",
      facts.handoffTested ? "Handoff homologado" : "Handoff disponível — homologação operacional pendente",
      facts.handoff,
      facts.handoffTested ? "tested" : facts.handoff ? "available" : "pending",
      facts.handoffTested === true,
    ),
  ];
}

export function missingOnboardingRequirements(items: OnboardingChecklistItem[]): string[] {
  return items.filter((item) => !item.activationReady).map((item) => item.label);
}

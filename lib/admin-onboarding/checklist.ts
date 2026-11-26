export type OnboardingChecklistKey =
  | "company" | "operation" | "sarah" | "catalog" | "operator"
  | "whatsapp" | "cart" | "oms" | "handoff";

export type OnboardingChecklistItem = {
  key: OnboardingChecklistKey;
  label: string;
  pass: boolean;
};

export type OnboardingChecklistFacts = {
  company: boolean;
  operation: boolean;
  sarah: boolean;
  catalog: boolean;
  operator: boolean;
  whatsapp: boolean;
  oms: boolean;
  handoff: boolean;
};

export function buildOnboardingChecklist(facts: OnboardingChecklistFacts): OnboardingChecklistItem[] {
  return [
    { key: "company", label: "Empresa configurada", pass: facts.company },
    { key: "operation", label: "Operação configurada", pass: facts.operation },
    { key: "sarah", label: "Sarah configurada e publicada", pass: facts.sarah },
    { key: "catalog", label: "Catálogo disponível", pass: facts.catalog },
    { key: "operator", label: "Operador associado e convite aceito", pass: facts.operator },
    { key: "whatsapp", label: "WhatsApp Meta conectado", pass: facts.whatsapp },
    { key: "cart", label: "Carrinho disponível", pass: facts.catalog },
    { key: "oms", label: "Pedidos e OMS disponíveis", pass: facts.oms },
    { key: "handoff", label: "Handoff disponível", pass: facts.handoff },
  ];
}

export function missingOnboardingRequirements(items: OnboardingChecklistItem[]): string[] {
  return items.filter((item) => !item.pass).map((item) => item.label);
}

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizard } from "./_client";
import {
  goToOnboardingStep,
  publishSarahMemory,
  saveSarahDraftSettings,
  saveOperatorSettings,
  sendOperatorInvite,
  getPendingOperatorInviteLink,
} from "@/app/actions/admin/onboarding";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/actions/admin/onboarding", () => ({
  activateFoodservice: vi.fn(),
  createCatalogCategory: vi.fn(),
  createCatalogProduct: vi.fn(),
  goToOnboardingStep: vi.fn().mockResolvedValue({ ok: true }),
  publishSarahMemory: vi.fn().mockResolvedValue({ ok: true, versionNumber: 1, unchanged: false }),
  saveCompanyProfile: vi.fn(),
  saveOperationSettings: vi.fn(),
  saveSarahDraftSettings: vi.fn().mockResolvedValue({ ok: true }),
  saveOperatorSettings: vi.fn().mockResolvedValue({ ok: true }),
  sendOperatorInvite: vi.fn().mockResolvedValue({ status: "sent", email: "agent@example.com" }),
  getPendingOperatorInviteLink: vi.fn().mockResolvedValue({ status: "ready", url: "https://crm.example.com/team/accept-invite/test-token" }),
  updateCatalogProduct: vi.fn(),
}));

const props = {
  organization: { id: "org-1", slug: "empresa-teste", name: "Empresa de teste", legalName: "" },
  initial: {
    company: {}, operation: {},
    sarah: {
      name: "Sarah", greeting: "Olá", rules: "", commercial_guidance: "",
      priority_products: "", upsell_guidance: "", handoff_guidance: "",
    },
    operator: {}, completedSteps: [], currentStep: "sarah", status: null, inviteStatus: "none" as const,
  },
  catalog: { categories: [], products: [] },
  checklist: [], canActivate: false, activeProducts: 0,
};

describe("navegação e publicação da memória da Sarah", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(goToOnboardingStep).mockResolvedValue({ ok: true });
    vi.mocked(saveSarahDraftSettings).mockResolvedValue({ ok: true });
    vi.mocked(publishSarahMemory).mockResolvedValue({ ok: true, versionNumber: 1, unchanged: false });
  });

  it("Voltar só muda a etapa local e não salva nem publica as orientações", async () => {
    render(<OnboardingWizard {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));

    await waitFor(() => expect(screen.getByText("Etapa 3 de 7 · Cardápio")).toBeInTheDocument());
    expect(goToOnboardingStep).not.toHaveBeenCalled();
    expect(saveSarahDraftSettings).not.toHaveBeenCalled();
    expect(publishSarahMemory).not.toHaveBeenCalled();
  });

  it("abrir Equipe não dispara gravações da etapa atual nem chamadas de navegação", async () => {
    render(<OnboardingWizard {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /5\s*Equipe/ }));

    expect(screen.getByText("Etapa 5 de 7 · Equipe")).toBeInTheDocument();
    expect(goToOnboardingStep).not.toHaveBeenCalled();
    expect(saveSarahDraftSettings).not.toHaveBeenCalled();
    expect(publishSarahMemory).not.toHaveBeenCalled();
  });

  it("salvar Equipe persiste configuração e destino no mesmo fluxo", async () => {
    render(<OnboardingWizard {...props} initial={{ ...props.initial, operator: { name: "Operador", email: "agent@example.com", role: "agent", handoff_responsible: true }, currentStep: "team" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Salvar e continuar" }));

    await waitFor(() => expect(saveOperatorSettings).toHaveBeenCalledWith("org-1", {
      name: "Operador", email: "agent@example.com", role: "agent", handoff_responsible: true,
    }, "whatsapp"));
    expect(goToOnboardingStep).not.toHaveBeenCalled();
  });

  it("usa ação explícita para reenviar convite pendente", async () => {
    render(<OnboardingWizard {...props} initial={{
      ...props.initial,
      operator: { name: "Operador", email: "agent@example.com", role: "agent", handoff_responsible: true },
      completedSteps: ["team"], currentStep: "team", inviteStatus: "pending",
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Reenviar convite" }));

    await waitFor(() => expect(sendOperatorInvite).toHaveBeenCalledWith("org-1", true));
  });

  it("copia link apenas ao pedir explicitamente o link de convite pendente", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<OnboardingWizard {...props} initial={{
      ...props.initial,
      operator: { name: "Operador", email: "agent@example.com", role: "agent", handoff_responsible: true },
      completedSteps: ["team"], currentStep: "team", inviteStatus: "pending",
    }} />);

    fireEvent.click(screen.getByRole("button", { name: "Copiar link de convite" }));

    await waitFor(() => expect(getPendingOperatorInviteLink).toHaveBeenCalledWith("org-1"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://crm.example.com/team/accept-invite/test-token"));
  });

  it("salvar e continuar persiste como rascunho sem publicar", async () => {
    render(<OnboardingWizard {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Salvar e continuar" }));

    await waitFor(() => expect(saveSarahDraftSettings).toHaveBeenCalledWith("org-1", props.initial.sarah));
    expect(publishSarahMemory).not.toHaveBeenCalled();
  });

  it("salvar rascunho não muda de etapa nem publica a memória", async () => {
    render(<OnboardingWizard {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));

    await waitFor(() => expect(saveSarahDraftSettings).toHaveBeenCalledWith("org-1", props.initial.sarah));
    expect(goToOnboardingStep).not.toHaveBeenCalled();
    expect(publishSarahMemory).not.toHaveBeenCalled();
  });

  it("só publica ao clicar na ação explícita e não duplica a versão atual", async () => {
    render(<OnboardingWizard {...props} />);
    expect(publishSarahMemory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Publicar orientações da Sarah" }));

    await waitFor(() => expect(publishSarahMemory).toHaveBeenCalledWith("org-1", props.initial.sarah));
  });
});

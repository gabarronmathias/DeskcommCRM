import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/onboarding/finishOnboarding", () => ({
  finishOnboarding: vi.fn(),
}));

import { DoneClient } from "./_client";

describe("DoneClient Foodservice activation gate", () => {
  it("shows that administrative activation is pending and hides the use button", () => {
    render(<DoneClient itens={[]} pecas={[]} foodserviceActivationPending />);
    expect(screen.getByRole("heading", { name: "Configuração inicial concluída" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("catálogo, Sarah, equipe e WhatsApp oficial");
    expect(screen.queryByRole("button", { name: "Começar a usar" })).toBeNull();
  });
});

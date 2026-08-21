import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { Sidebar } from "@/components/shell/Sidebar";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

/**
 * O CONSUMIDOR do nome por organização — provado por comportamento, não por
 * símbolo.
 *
 * POR QUE ESTE ARQUIVO EXISTE: medido antes de escrever a feature, o nome da
 * organização não aparecia em lugar nenhum da casca para o cliente típico de um
 * revendedor — o único leitor era o `TenantSwitcher`, que devolve `null` com uma
 * organização só. Gravar `settings.branding.app_name` sem um leitor real teria
 * criado o campo decorativo clássico: a tela oferece, o código ignora, e o
 * cliente conclui que o produto está quebrado.
 *
 * Conferir que a Sidebar MENCIONA `activeOrg.marca` não bastaria — é evidência
 * de símbolo presente, não de comportamento presente. Os dois casos abaixo
 * medem o texto que a barra renderiza, com e sem a marca, e o segundo afirma
 * também a AUSÊNCIA do nome da instalação: sem isso, um componente que
 * mostrasse os dois passaria.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/app/inbox" }));
vi.mock("@/app/actions/shell/toggleSidebar", () => ({ toggleSidebar: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
// Os dois buscam estado do servidor e não têm nada a ver com o nome da marca.
vi.mock("@/components/connections/ConnectionHealthDot", () => ({
  ConnectionHealthDot: () => null,
}));
vi.mock("@/components/shell/VersionFooter", () => ({ VersionFooter: () => null }));

/**
 * A marca da INSTALAÇÃO, que é o que a barra mostrava antes desta fase.
 *
 * Sem `logoUrl`: com um logo configurado a barra mostra a imagem no lugar do
 * texto, e nenhum dos dois casos abaixo mediria coisa alguma. Essa ressalva está
 * escrita na tela, no bloco "o que isto ainda não muda".
 */
vi.mock("@/lib/branding", () => ({
  branding: () => ({ name: "Sistema do Revendedor", logoUrl: null, initial: "S" }),
}));

const usuario = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@exemplo.test",
  is_platform_admin: false,
  organizations: [],
} as unknown as AuthUser;

const org = {
  orgId: "00000000-0000-4000-8000-0000000000aa",
  name: "Loja da Ana",
  role: "admin",
} as ActiveOrg;

let contexto: { user: AuthUser; activeOrg: ActiveOrg | null } = { user: usuario, activeOrg: org };
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => contexto,
}));

describe("o nome da marca na barra lateral", () => {
  it("sem marca da organização, mostra o nome da instalação", () => {
    // Não-regressão: a organização que nunca abriu a tela de marca precisa ver
    // exatamente o que via antes. É também a guarda de vacuidade do caso
    // seguinte — se a barra nunca mostrasse nome nenhum, os dois passariam.
    contexto = { user: usuario, activeOrg: org };
    render(<Sidebar collapsed={false} />);
    expect(screen.getByText("Sistema do Revendedor")).toBeTruthy();
  });

  it("com marca da organização, o nome dela SUBSTITUI o da instalação", () => {
    contexto = { user: usuario, activeOrg: { ...org, marca: { nome: "Loja da Ana" } } };
    render(<Sidebar collapsed={false} />);
    expect(screen.getByText("Loja da Ana")).toBeTruthy();
    // A ausência importa tanto quanto a presença: uma barra que mostrasse os
    // dois nomes passaria na asserção de cima e estaria errada.
    expect(screen.queryByText("Sistema do Revendedor")).toBeNull();
  });

  it("recolhida, a inicial acompanha o nome que a barra mostra", () => {
    // Sem isto, recolher o menu trocaria a marca: o nome viria da organização e
    // a inicial continuaria vindo de `branding()` — "L" expandido, "S" recolhido.
    contexto = { user: usuario, activeOrg: { ...org, marca: { nome: "Loja da Ana" } } };
    render(<Sidebar collapsed />);
    expect(screen.getByText("L")).toBeTruthy();
    expect(screen.queryByText("S")).toBeNull();
  });

  it("usa o logo da organização e mantém o nome legível", () => {
    contexto = {
      user: usuario,
      activeOrg: { ...org, marca: { nome: "Gabarron & Mathias", logoUrl: "/branding/gabarron-mathias-logo.jpg" } },
    };
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("img", { name: "Gabarron & Mathias" }).getAttribute("src")).toBe(
      "/branding/gabarron-mathias-logo.jpg",
    );
    expect(screen.getByText("Gabarron & Mathias")).toBeTruthy();
  });
});

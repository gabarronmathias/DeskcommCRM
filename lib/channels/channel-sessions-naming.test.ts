/**
 * Testes da política de nomes do onboarding de canais.
 *
 * Investigação 2026-09-04: a org gabarron-mathias tinha um canal com
 * `waha_session_name = "default"`. Este arquivo é a guarda unit-level:
 * isChannelSessionNamePlaceholder() classifica os valores problemáticos,
 * e resolveChannelSessionName() garante que código novo nunca persista
 * esses valores como nome de uma sessão NOVA.
 */
import { describe, expect, it } from "vitest";

import { isChannelSessionNamePlaceholder, resolveChannelSessionName } from "./channel-sessions-naming";

describe("isChannelSessionNamePlaceholder", () => {
  it("rejeita string vazia", () => {
    expect(isChannelSessionNamePlaceholder("")).toBe(true);
  });
  it('rejeita " " (whitespace)', () => {
    expect(isChannelSessionNamePlaceholder("   ")).toBe(true);
  });
  it('rejeita "null" (sentinela de debug)', () => {
    expect(isChannelSessionNamePlaceholder("null")).toBe(true);
  });
  it('rejeita "undefined" (sentinela de debug)', () => {
    expect(isChannelSessionNamePlaceholder("undefined")).toBe(true);
  });
  it('ACEITA "default" (nome real da sessao WAHA legacy, preservado)', () => {
    // "default" e o nome REAL da sessao WAHA Plus legada da
    // gabarron-mathias — NAO e placeholder, e o codigo REUSA.
    expect(isChannelSessionNamePlaceholder("default")).toBe(false);
  });
  it('ACEITA "DEFAULT" (case-insensitive no fail-closed tambem nao trata)', () => {
    expect(isChannelSessionNamePlaceholder("DEFAULT")).toBe(false);
  });
  it("rejeita null e undefined (parametros)", () => {
    expect(isChannelSessionNamePlaceholder(null)).toBe(true);
    expect(isChannelSessionNamePlaceholder(undefined)).toBe(true);
  });
  it('ACEITA "sarah-gb-sjc" (nome real da org)', () => {
    expect(isChannelSessionNamePlaceholder("sarah-gb-sjc")).toBe(false);
  });
  it('ACEITA "org_3f1c4b2e" (gerado pelo codigo)', () => {
    expect(isChannelSessionNamePlaceholder("org_3f1c4b2e")).toBe(false);
  });
});

describe("resolveChannelSessionName", () => {
  const ORG = "3f1c4b2e-1234-5678-9abc-def012345678";

  it('reusa "default" (nome real) se o existing tem esse valor', () => {
    // A sessao WAHA Plus legacy da org gabarron-mathias se chama "default".
    // O codigo REUSA esse nome, nao gera um novo — preserva a pareadade.
    expect(resolveChannelSessionName("default", ORG)).toBe("default");
  });

  it('reusa "sarah-gb-sjc" se o existing tem esse valor', () => {
    expect(resolveChannelSessionName("sarah-gb-sjc", ORG)).toBe("sarah-gb-sjc");
  });

  it('gera "org_<8hex>" se o existing é null', () => {
    expect(resolveChannelSessionName(null, ORG)).toBe("org_3f1c4b2e");
  });

  it('gera "org_<8hex>" se o existing é undefined', () => {
    expect(resolveChannelSessionName(undefined, ORG)).toBe("org_3f1c4b2e");
  });

  it('gera "org_<8hex>" se o existing é vazio', () => {
    expect(resolveChannelSessionName("", ORG)).toBe("org_3f1c4b2e");
  });

  it('gera "org_<8hex>" se o existing é placeholder (default, null, undefined)', () => {
    expect(resolveChannelSessionName("default", ORG)).toBe("default"); // reusa o nome real
    expect(resolveChannelSessionName("null", ORG)).toBe("org_3f1c4b2e");
    expect(resolveChannelSessionName("undefined", ORG)).toBe("org_3f1c4b2e");
  });
});

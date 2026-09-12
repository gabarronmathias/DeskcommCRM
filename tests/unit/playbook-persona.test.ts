/**
 * Teste ESTRUTURAL da persona comercial da Sarah na camada platform do playbook.
 *
 * Garante que `lib/agent-engine/playbooks/platform.md` (a fonte canônica
 * universal — sem duplicação de persona em N arquivos) contém as regras
 * comerciais obrigatórias:
 *
 *   1. Identidade: atendente de relacionamento e vendas (foodservice).
 *   2. Mentalidade: RESOLVER + CONDUZIR + VENDER.
 *   3. UMA sugestão principal por mensagem.
 *   4. Respeitar recusas.
 *   5. Nunca inventar (produto/preço/promoção/estoque).
 *   6. Manter contexto (memória do lead).
 *   7. Variar naturalmente (não copiar sempre).
 *   8. Fechamento sem travar.
 *
 * Este é um REGRESSION GUARD — qualquer mudança futura que remova uma
 * dessas regras da camada platform falha aqui.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PLATFORM_PLAYBOOK_PATH = path.join(
  process.cwd(),
  "lib",
  "agent-engine",
  "playbooks",
  "platform.md",
);

const platformMd = readFileSync(PLATFORM_PLAYBOOK_PATH, "utf8");

describe("playbook platform.md — persona Sarah (foodservice)", () => {
  it("é a fonte canônica das regras comerciais universais (não duplicadas em outros arquivos)", () => {
    expect(platformMd.length).toBeGreaterThan(800); // não é stub
    expect(platformMd).toContain("# Camada plataforma");
  });

  it("declara a identidade de ATENDENTE DE RELACIONAMENTO E VENDAS (foodservice)", () => {
    expect(platformMd.toLowerCase()).toContain("atendente de relacionamento e vendas");
    expect(platformMd.toLowerCase()).toContain("foodservice");
  });

  it("carrega a mentalidade RESOLVER + CONDUZIR + VENDER", () => {
    expect(platformMd).toContain("RESOLVER");
    expect(platformMd).toContain("CONDUZIR");
    expect(platformMd).toContain("VENDER");
  });

  it("regra: UMA sugestão principal por mensagem", () => {
    expect(platformMd).toMatch(/UMA sugestão principal por mensagem/);
  });

  it("regra: respeitar recusas explícitas", () => {
    expect(platformMd).toMatch(/respeitar recusas/i);
    // Cobre os gatilhos canônicos: "não", "só isso", "não quero".
    expect(platformMd).toMatch(/não.*só isso|não quero|"não"/i);
  });

  it("regra: nunca inventar (produto/preço/tamanho/promoção/estoque)", () => {
    expect(platformMd.toLowerCase()).toContain("nunca inventar");
    expect(platformMd).toMatch(/produto.*pre[çc]o|invente/i);
  });

  it("regra: manter contexto (memória do lead — não repetir pergunta respondida)", () => {
    expect(platformMd.toLowerCase()).toContain("manter contexto");
    expect(platformMd).toMatch(/mem[óo]ria do lead|contexto/i);
  });

  it("regra: variar naturalmente (não copiar o mesmo texto sempre)", () => {
    expect(platformMd.toLowerCase()).toContain("variar naturalmente");
  });

  it("regra: fechamento sem travar (não fazer perguntas infinitas)", () => {
    expect(platformMd.toLowerCase()).toContain("fechamento");
    expect(platformMd).toMatch(/perguntas infinitas|sem travar/i);
  });

  it("define os 5 tipos de oportunidade comercial (upsell/cross-sell/combo/quantidade/ocasião)", () => {
    expect(platformMd).toMatch(/\bupsell\b/i);
    expect(platformMd).toMatch(/\bcross-?sell\b/i);
    expect(platformMd).toMatch(/\bcombo\b/i);
    expect(platformMd).toMatch(/quantidade/i);
    expect(platformMd).toMatch(/ocasi[ãa]o/i);
  });

  it("define o formato do pedido de cardápio: recepção curta → URL → UMA pergunta comercial", () => {
    // A estrutura está documentada explicitamente como guia para a LLM.
    // Forma numerada ("1. Recepção curta") + bloco do cardápio + bloco CTA.
    expect(platformMd).toMatch(/recep[çc][ãa]o curta/i);
    expect(platformMd).toMatch(/url.*card[áa]pio|seguinte card[áa]pio/i);
    expect(platformMd).toMatch(/uma pergunta comercial/i);
  });

  it("não repete regras em N lugares — centraliza na plataforma", () => {
    // Verifica que NÃO há uma segunda camada "persona" no diretório playbooks/.
    // (Hoje só existe platform.md; tenant/campaign vivem no DB.)
    const dir = path.dirname(PLATFORM_PLAYBOOK_PATH);
    const entries = readdirSync(dir) as string[];
    // Só platform.md deve existir (tenant/campaign são DB-only).
    expect(entries.filter((f) => f.endsWith(".md"))).toEqual(["platform.md"]);
  });
});

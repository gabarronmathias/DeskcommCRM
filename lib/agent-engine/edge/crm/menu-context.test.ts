/**
 * Testes da PERSONA COMERCIAL DA SARAH no `buildMenuReply` (foodservice).
 *
 * Estes testes garantem que a abertura determinística do cardápio (o
 * fast-path preservado pelo commit 093f9a50) reflete a nova persona:
 *
 *   1. Recepção curta, simpática, com nome quando conhecido.
 *   2. URL oficial sempre presente, sem invenção.
 *   3. UMA pergunta comercial (CTA) que abre caminho para venda.
 *   4. Nenhuma referência a produtos/preços não verificados.
 *   5. Determinístico: mesma entrada → mesmo byte-a-byte (sem LLM).
 *
 * Os comportamentos de LLM (recusa respeitada, indecisão conduzida, etc.)
 * são regidos pela camada platform do playbook e cobertos pelo teste
 * estrutural em tests/unit/playbook-persona.test.ts.
 */
import { describe, expect, it } from "vitest";
import { buildMenuReply } from "./menu-context";

const MENU_URL = "https://cardapio.sistemaathos.com.br/tortasdocalmon";

describe("buildMenuReply — persona Sarah foodservice (fix menu-lookup-do-caminho-crítico)", () => {
  // Estrutura canônica: recepção → URL → UMA pergunta comercial.
  it("inclui a URL oficial do cardápio (nunca inventa)", () => {
    const out = buildMenuReply(MENU_URL);
    expect(out).toContain(MENU_URL);
    expect(out).not.toContain("R$");        // nunca inventa preço
    // Não sugere produto específico no CORPO (a URL é o único lugar onde
    // aparece "torta" porque é o slug do tenant — verificado fora do corpo).
    const bodyWithoutUrl = out.replace(MENU_URL, "");
    expect(bodyWithoutUrl).not.toMatch(/torta|pão|pizza|bolo|refrigerante|sobremesa/i);
  });

  it("inclui UMA pergunta comercial curta (CTA que conduz a venda)", () => {
    const out = buildMenuReply(MENU_URL);
    // CTA contém interrogação (a pergunta pode terminar com emoji opcional).
    expect(out).toMatch(/\?|😄|😀|🙂/);
    // O CTA é sobre conduzir a venda (pessoas, ocasião, preferência).
    expect(out).toMatch(/pessoas|ocasi[ãa]o|prefer|pedido|pedir|escolh|combina|mais pedidos|sugerir/i);
    // NÃO deve listar 5 adicionais de uma vez — o tamanho do CTA é curto.
    const lastLine = out.split("\n").filter(Boolean).at(-1) ?? "";
    expect(lastLine.length).toBeLessThan(160);
    // A pergunta comercial principal fica no BLOCO final (CTA), separada da
    // saudação. Verifica que o bloco do CTA contém exatamente UMA "?".
    const ctaBlock = out.split("\n\n").at(-1) ?? "";
    const ctaQuestionCount = (ctaBlock.match(/\?/g) ?? []).length;
    expect(ctaQuestionCount).toBe(1);
  });

  it("usa saudação com nome quando o contato é conhecido (recepção simpática)", () => {
    const out = buildMenuReply(MENU_URL, "Thailer");
    expect(out).toContain("Thailer");
    expect(out).toMatch(/^Oi, Thailer/);
  });

  it("usa saudação genérica simpática quando o contato é desconhecido", () => {
    const out = buildMenuReply(MENU_URL);
    expect(out).toMatch(/^Oi[!.]/);
    expect(out).toContain("😊");
  });

  it("respeita contato nulo/vazio com saudação genérica (não quebra)", () => {
    expect(buildMenuReply(MENU_URL, null)).toMatch(/^Oi/);
    expect(buildMenuReply(MENU_URL, "")).toMatch(/^Oi/);
    expect(buildMenuReply(MENU_URL, "   ")).toMatch(/^Oi/);
  });

  it("é determinístico — mesma entrada produz byte-a-byte a mesma saída (fast path preservado)", () => {
    const a = buildMenuReply(MENU_URL, "Thailer");
    const b = buildMenuReply(MENU_URL, "Thailer");
    expect(a).toBe(b);
    // Estrutura em 3 blocos separados por linha em branco (recepção | url | CTA).
    const blocks = a.split("\n\n");
    expect(blocks).toHaveLength(3);
  });

  it("FAST PATH: buildMenuReply é síncrono — não consulta rede, lookup ou LLM", () => {
    // O retorno vem direto sem awaits; mede que o resultado está disponível
    // síncronamente (a função não precisa de async). Se virar async no futuro,
    // este teste falha e força revisão consciente do fast path.
    const result = buildMenuReply(MENU_URL, "X");
    expect(typeof result).toBe("string");
    // Não retorna Promise — fast-path preservado.
    expect((result as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("não repete a mesma saudação quando o nome é diferente (variação natural por contato)", () => {
    const a = buildMenuReply(MENU_URL, "Ana");
    const b = buildMenuReply(MENU_URL, "Bruno");
    expect(a).not.toBe(b);
    expect(a).toContain("Ana");
    expect(b).toContain("Bruno");
  });
});

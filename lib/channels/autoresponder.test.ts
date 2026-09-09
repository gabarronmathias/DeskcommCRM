/**
 * Testes do classificador de autoresposta.
 *
 * 9 cenários (do brief):
 *   1. autoresponder promocional da Paizzani → autoresponder
 *   2. "Sim, tenho interesse" → humano
 *   3. "Quanto custa?" → humano
 *   4. "Não tenho interesse" → humano (recusa)
 *   5. "Olá, recebemos sua mensagem. Confira nosso cardápio..." → autoresponder
 *   6. mensagem automática + link → autoresponder
 *   7. mensagem humana longa mencionando cardápio → NÃO autoresponder (sem falso positivo)
 *   8. resposta Sarah usa channel_session correto → coberto por session-ref.test.ts
 *   9. sem channel_session válida → fail closed → coberto por session-ref.test.ts
 */
import { describe, expect, it } from "vitest";

import { classificarRespostaAutomatica } from "./autoresponder";

const RESP_RAPIDA = 30_000; // 30s após o último outbound

describe("classificarRespostaAutomatica", () => {
  it("cenario 1: autoresponder promocional da Paizzani (exemplo real de 2026-09-04) → autoresponder", () => {
    const texto = [
      "Eba! Você chegou na melhor Pizzaria de São José! Esse é o lugar perfeito",
      "para deixar a sua noite ainda mais gostosa! 🍕",
      "Você chegou a tempo de aproveitar nosso rodízio COMPLETO com sobremesa",
      "inclusa por apenas R$89,90.",
      "Bora garantir sua reserva e ganhe um desconto especial!!🍽️",
      "Mas se preferir, nosso Delivery está prontinho para entregar sua pizza",
      "preferida! Vou te encaminhar o nosso cardápio, tá bom?🍕",
    ].join("\n");
    const r = classificarRespostaAutomatica(texto, { msDesdeUltimoOutbound: 30_000 });
    expect(r.score).toBeGreaterThanOrEqual(3);
    expect(r.isAutoresposta).toBe(true);
    // As razões que DEVEM casar neste caso:
    expect(r.sinais.find((s) => s.codigo === "S5_multi_opcoes")?.contribuiu).toBe(true); // cardápio, delivery, reserva, rodízio, desconto
    expect(r.sinais.find((s) => s.codigo === "S7_densidade_emoji")?.contribuiu).toBe(true);
    expect(r.sinais.find((s) => s.codigo === "S8_cta_promocional")?.contribuiu).toBe(true); // "garantir", "reserve"
  });

  it("cenario 2: 'Sim, tenho interesse' → humano (curto, com resposta)", () => {
    const r = classificarRespostaAutomatica("Sim, tenho interesse. Podemos conversar?", {
      msDesdeUltimoOutbound: 5 * 60_000, // 5 min
    });
    expect(r.isAutoresposta).toBe(false);
  });

  it("cenario 3: 'Quanto custa?' → humano", () => {
    const r = classificarRespostaAutomatica("Quanto custa o serviço de vocês?", {
      msDesdeUltimoOutbound: 10 * 60_000,
    });
    expect(r.isAutoresposta).toBe(false);
  });

  it("cenario 4: 'Não tenho interesse' → humano (recusa, sem autoresponder)", () => {
    const r = classificarRespostaAutomatica("Não tenho interesse, obrigado.", {
      msDesdeUltimoOutbound: 8 * 60_000,
    });
    expect(r.isAutoresposta).toBe(false);
    // É humano mesmo sendo negativo — quem pede para sair é o opt-out handler,
    // não o classificador de autoresponder.
  });

  it("cenario 5: 'Olá, recebemos sua mensagem. Confira nosso cardápio...' → autoresponder", () => {
    const texto = [
      "Olá, recebemos sua mensagem! 🍕",
      "Confira nosso cardápio digital:",
      "Temos opções de delivery, retirada no balcão e reserva para o salão.",
    ].join("\n");
    const r = classificarRespostaAutomatica(texto, { msDesdeUltimoOutbound: 45_000 });
    expect(r.isAutoresposta).toBe(true);
    expect(r.sinais.find((s) => s.codigo === "S3_saudacao_institucional")?.contribuiu).toBe(true);
  });

  it("cenario 6: mensagem automática + link → autoresponder", () => {
    const texto = [
      "Oi! Somos a Hamburgueria XYZ, a melhor da região! 🍔",
      "Recebemos seu contato. Para fazer seu pedido, acesse: https://pedido.exemplo.com",
      "Temos delivery, retirada e reserva. Aproveite nossa promoção de hoje!",
    ].join("\n");
    const r = classificarRespostaAutomatica(texto, { msDesdeUltimoOutbound: 20_000 });
    expect(r.isAutoresposta).toBe(true);
  });

  it("cenario 7: humana longa mencionando cardápio → NÃO autoresponder (sem falso positivo)", () => {
    // humana de verdade: menciona cardápio, mas também atende à pergunta e usa
    // pronomes que indicam continuidade de conversa.
    const texto = [
      "Oi! Tudo bem? Atendemos sim, nosso foco é delivery para a região de",
      "São José. Trabalhamos com um sistema próprio pelo WhatsApp — o cliente",
      "faz o pedido e a gente confirma em até 10 minutos. Nosso cardápio tem",
      "umas 40 opções entre pizzas e hambúrgueres. Quer que eu te mande o",
      "catálogo com os preços?",
    ].join("\n");
    const r = classificarRespostaAutomatica(texto, { msDesdeUltimoOutbound: 4 * 60_000 });
    expect(r.isAutoresposta).toBe(false);
    // S6 (ausência de resposta) NÃO pode casar porque temos "atendemos" e "trabalhamos"
    expect(r.sinais.find((s) => s.codigo === "S6_ausencia_resposta")?.contribuiu).toBe(false);
  });

  it("cenário 1 sem timing: o score S1 (timing) é null-safe, mas outros sinais sustentam a decisão", () => {
    const texto = [
      "Eba! Você chegou na melhor Pizzaria de São José!",
      "Aproveite nosso rodízio, delivery, reserva e promoção. Confira o cardápio! 🍕🍕🍕",
      "Garanta sua reserva agora!",
    ].join("\n");
    const r = classificarRespostaAutomatica(texto, { msDesdeUltimoOutbound: null });
    // S1 não pontua (sem referência), mas S2/S5/S7/S8 devem sustentar
    expect(r.score).toBeGreaterThanOrEqual(3);
    expect(r.isAutoresposta).toBe(true);
  });

  it("threshold 5 é o modo PARANOID — só autoresponder muito óbvio", () => {
    const texto = "Olá! Confira nosso cardápio. Delivery, reserva, retirada.";
    const r = classificarRespostaAutomatica(texto, { msDesdeUltimoOutbound: null }, 5);
    expect(r.isAutoresposta).toBe(false); // com threshold 5, score 2 não basta
  });

  it("texto vazio / nulo → score 0, não autoresponder", () => {
    expect(classificarRespostaAutomatica(null, { msDesdeUltimoOutbound: 30_000 }).score).toBe(0);
    expect(classificarRespostaAutomatica("", { msDesdeUltimoOutbound: 30_000 }).score).toBe(0);
    expect(classificarRespostaAutomatica("   ", { msDesdeUltimoOutbound: 30_000 }).score).toBe(0);
  });

  it("timing > 60s zera S1 mesmo que a mensagem seja longa", () => {
    const textoLongo = "Olá! ".repeat(50);
    const r = classificarRespostaAutomatica(textoLongo, { msDesdeUltimoOutbound: 5 * 60_000 });
    expect(r.sinais.find((s) => s.codigo === "S1_timing_resposta")?.contribuiu).toBe(false);
  });
});

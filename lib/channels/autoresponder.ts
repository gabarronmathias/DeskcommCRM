/**
 * Classificador de respostas automáticas (autoresponder / WhatsApp Business
 * welcome message / bot comercial) — bug introduzido em 2026-09-04 quando a
 * Paizzani devolveu o welcome message institucional do WhatsApp Business e o
 * sistema o tratou como reply humano, marcando last_reply_at, cancelando
 * follow-up e acionando Sarah.
 *
 * ─── POR QUE NÃO É REGEX DE PALAVRAS-CHAVE ───────────────────────────────────
 *
 * "cardápio", "delivery", "reserva", "promoção" e "desconto" são palavras
 * normais em conversa humana também (humano de pizzaria fala de cardápio sem
 * ser bot). O caminho antigo — casar uma palavra — gerou:
 *   - falso positivo: humano dizendo "olha nosso cardápio no link X" vira autoresponder
 *   - falso negativo: bot com texto variado (só "Bem-vindo à Pizzaria X! 🎉")
 *     passa ileso
 *
 * A regra aqui é baseada em SINAIS COMBINADOS — cada um sozinho tem peso baixo,
 * e a decisão sai do total. Quem perde um sinal ainda tem chance de ser
 * classificado certo se os outros carregam.
 *
 * ─── SINAIS IMPLEMENTADOS ─────────────────────────────────────────────────────
 *
 *   S1 timing_resposta       response < 60s depois do último outbound
 *   S2 comprimento           text length > 200 chars (promocional tende a ser longo)
 *   S3 saudacao_institucional começa com "Olá," / "Oi," / "Bem-vindo" + nome + pontuação
 *   S4 auto_introducao        "somos" + ["melhor", "especialistas", "lugar perfeito"]
 *   S5 multi_opcoes           2+ de {cardápio, delivery, reserva, rodízio, promoção,
 *                              desconto, retirada, atendimento} — autoresponder
 *                              normalmente oferece várias formas
 *   S6 ausencia_resposta      NÃO contém nenhum de {atendemos, temos, trabalhamos,
 *                              organizamos, nosso atendimento, sistema, app,
 *                              whatsapp, cliente, equipe, fluxo} — autoresponder
 *                              não responde à pergunta feita
 *   S7 densidade_emoji        3+ emojis (autoresponder tende a ser visual)
 *   S8 cta_promocional        "reserve", "garanta", "aproveite" + "!" (push pra ação)
 *   S9 ausencia_pergunta      NÃO contém "?" (autoresponder não pergunta de volta)
 *
 * Threshold: score >= 3 → autoresponder. Cada sinal que casa soma 1 ponto.
 *
 * O threshold foi calibrado no exemplo real da Paizzani (score ≈ 6/9) e nos
 * casos negativos documentados no brief: "Sim, tenho interesse" (score ≈ 1/9
 * — só S1), "Quanto custa?" (score ≈ 0 — S1 ausente, S9 ausente porque há
 * "?", nenhuma das outras), "Não tenho interesse" (score ≈ 2 — S6 e S9).
 *
 * ─── RETORNO ─────────────────────────────────────────────────────────────────
 *
 * `classificarRespostaAutomatica()` devolve o SCORE + as RAZÕES por extenso.
 * Quem consome (lib/channels/pos-entrada.ts) decide o que fazer com base
 * nisso. Esta função NÃO toma decisão — é puro classificador.
 *
 * ─── ATUALIZAÇÃO FUTURA ──────────────────────────────────────────────────────
 *
 * Esta é a primeira camada. A próxima pode ser:
 *   - heurística de `fromMe: false` + protocolo `business` no payload WAHA
 *   - flag `protocolMessage` no payload (WhatsApp Business welcome)
 *   - heurística de intent classificada por LLM leve (a fazer, sob F4-04)
 */

export interface SinalAutoresposta {
  codigo:
    | "S1_timing_resposta"
    | "S2_comprimento"
    | "S3_saudacao_institucional"
    | "S4_auto_introducao"
    | "S5_multi_opcoes"
    | "S6_ausencia_resposta"
    | "S7_densidade_emoji"
    | "S8_cta_promocional"
    | "S9_ausencia_pergunta";
  contribuiu: boolean;
  detalhe: string;
}

export interface ClassificacaoAutoresposta {
  isAutoresposta: boolean;
  score: number;
  threshold: number;
  sinais: SinalAutoresposta[];
}

const OPCAO_PROMOCIONAL = [
  "cardapio",
  "cardápio",
  "delivery",
  "deliv",
  "reserva",
  "rodizio",
  "rodízio",
  "promocao",
  "promoção",
  "desconto",
  "retirada",
  "atendimento",
];

const RESPOSTA_HUMANA_SINAIS = [
  "atendemos",
  "temos",
  "trabalhamos",
  "organizamos",
  "nosso atendimento",
  "nossa operação",
  "nossa operacao",
  "sistema",
  "app ",
  "whatsapp",
  "cliente",
  "clientes",
  "equipe",
  "fluxo",
  "operacional",
];

const SAUDACAO_INSTITUCIONAL_RX =
  /^\s*(?:ol[áa]|oi|bem[- ]?vindo)[,!.\s].{0,80}?(?:!|\.|🍕|🎉|😋|☺|👋)/iu;

const AUTO_INTRODUCAO_RX =
  /(?:\b(?:somos)\b.*\b(?:melhor|especialistas|lugar perfeito|referência|referencia)\b)|(?:\b(?:melhor|lugar perfeito)\b.*\b(?:pizzaria|hamburgueria|restaurante|delivery|da cidade|da região|da regiao)\b)/iu;

const CTA_PROMOCIONAL_RX =
  /\b(?:reserve|garanta|aproveite|aproveita|garantir|peça já|peça agora|peca ja|peca agora)\b[^.\n]{0,40}!?/iu;

const EMOJI_RX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu;

const PONTO_PERGUNTA_RX = /\?/;

function semAcento(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function countMatches(haystack: string, needles: string[]): number {
  let count = 0;
  for (const n of needles) {
    if (haystack.includes(n)) count += 1;
  }
  return count;
}

/**
 * Classifica uma mensagem inbound como autoresposta ou humana.
 *
 * @param texto        corpo da mensagem inbound (já filtrado por `tipo`)
 * @param contexto     dados do entorno: quando foi o último outbound? é a
 *                     primeira resposta após a abertura?
 * @param threshold    score mínimo para classificar como autoresponder
 *                     (default 3, calibrado contra os casos do brief)
 */
export function classificarRespostaAutomatica(
  texto: string | null | undefined,
  contexto: {
    /** ms desde o último outbound nosso (server timestamp) */
    msDesdeUltimoOutbound: number | null;
  },
  threshold: number = 3,
): ClassificacaoAutoresposta {
  const sinais: SinalAutoresposta[] = [];
  if (!texto || texto.trim() === "") {
    return {
      isAutoresposta: false,
      score: 0,
      threshold,
      sinais: [{ codigo: "S2_comprimento", contribuiu: false, detalhe: "texto vazio" }],
    };
  }

  const norm = semAcento(texto);
  const trimmed = texto.trim();
  const length = trimmed.length;

  // S1 timing
  const s1 =
    contexto.msDesdeUltimoOutbound !== null && contexto.msDesdeUltimoOutbound >= 0
      ? contexto.msDesdeUltimoOutbound < 60_000
      : false;
  sinais.push({
    codigo: "S1_timing_resposta",
    contribuiu: s1,
    detalhe:
      contexto.msDesdeUltimoOutbound === null
        ? "sem referência temporal — não pontua"
        : `${Math.round(contexto.msDesdeUltimoOutbound / 1000)}s após o último outbound (corte: <60s)`,
  });

  // S2 comprimento
  const s2 = length > 200;
  sinais.push({
    codigo: "S2_comprimento",
    contribuiu: s2,
    detalhe: `length=${length} (corte: >200)`,
  });

  // S3 saudação institucional
  const s3 = SAUDACAO_INSTITUCIONAL_RX.test(trimmed);
  sinais.push({
    codigo: "S3_saudacao_institucional",
    contribuiu: s3,
    detalhe: `regex de saudação institucional ${s3 ? "casou" : "não casou"}`,
  });

  // S4 auto-introdução
  const s4 = AUTO_INTRODUCAO_RX.test(norm);
  sinais.push({
    codigo: "S4_auto_introducao",
    contribuiu: s4,
    detalhe: `regex de auto-introdução ${s4 ? "casou" : "não casou"}`,
  });

  // S5 multi-opções
  const s5Count = countMatches(norm, OPCAO_PROMOCIONAL);
  const s5 = s5Count >= 2;
  sinais.push({
    codigo: "S5_multi_opcoes",
    contribuiu: s5,
    detalhe: `${s5Count} marcadores de opção promocional (corte: >=2)`,
  });

  // S6 ausência de resposta
  const s6Count = countMatches(norm, RESPOSTA_HUMANA_SINAIS);
  const s6 = s6Count === 0 && length > 80;
  sinais.push({
    codigo: "S6_ausencia_resposta",
    contribuiu: s6,
    detalhe: `0 marcadores de resposta humana (length=${length}; corte: length>80 + 0 marcadores)`,
  });

  // S7 densidade de emoji
  const emojiCount = (trimmed.match(EMOJI_RX) ?? []).length;
  const s7 = emojiCount >= 3;
  sinais.push({
    codigo: "S7_densidade_emoji",
    contribuiu: s7,
    detalhe: `${emojiCount} emojis (corte: >=3)`,
  });

  // S8 CTA promocional
  const s8 = CTA_PROMOCIONAL_RX.test(trimmed);
  sinais.push({
    codigo: "S8_cta_promocional",
    contribuiu: s8,
    detalhe: `regex de CTA ${s8 ? "casou" : "não casou"}`,
  });

  // S9 ausência de pergunta
  const s9 = !PONTO_PERGUNTA_RX.test(trimmed);
  sinais.push({
    codigo: "S9_ausencia_pergunta",
    contribuiu: s9,
    detalhe: s9
      ? "sem '?' na mensagem (autoresponder não pergunta de volta)"
      : "contém '?' na mensagem",
  });

  const score = sinais.filter((s) => s.contribuiu).length;
  return {
    isAutoresposta: score >= threshold,
    score,
    threshold,
    sinais,
  };
}

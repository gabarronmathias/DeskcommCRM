/**
 * Fast-skip determinístico para a camada SEMÂNTICA de promessa (F4-02) — briefing
 * de latência Sarah 2026-09-12, achado 4.
 *
 * A camada semântica classifica promessa/compromisso EM TEXTO LIVRE (a F4-01,
 * determinística, só pega valor ESTRUTURADO — R$/%/parcelas). No cenário medido
 * em Tortas do Calmon, o classificador LLM rodava em ~12.2s POR ENVIO mesmo
 * quando a candidata era inócua ("somos em 6 pessoas"). A regex abaixo
 * cataloga as keywords/frases que SINALIZAM potencial promessa concreta em
 * PT-BR. Se NENHUMA casa na candidata, é certeza razoável de "sem promessa":
 * pula a chamada LLM inteira (fail-open).
 *
 * ⚠️ REGRA DE SEGURANÇA: regex COM match NÃO vira promessa — o classificador
 * LLM ainda roda pra desambiguar (slogans genéricos como "garantimos qualidade"
 * casam a regex mas são inocentes — ver acceptance test em
 * tests/unit/promise-semantic-fast-skip.test.ts).
 *
 * ⚠️ ESCOPO: PT-BR apenas (a Sarah comercial fala pt-br). Para outros idiomas,
 * estender com sufixos localizados — não estender aqui sem cobertura de teste.
 */

/**
 * Pattern de keywords/frases de promessa/compromisso em texto livre.
 *
 * Tokens cobertos:
 *   - gratuidade / cortesia / isenção / brinde / bônus
 *   - garantia / prometo / confirmo (prazo)
 *   - entrega/prazo concreto: "entrega amanhã", "fica pronto até", "resolvo até"
 *   - verbos de compromisso: "faço por", "fazemos por"
 *   - descontos duros: "100% de desconto", "isent[oa] taxa"
 *
 * Slogans/genéricos NÃO bloqueiam (o classificador LLM é que decide), mas a
 * regex casa — proposital, pra que o LLM ainda valide.
 */
// ⚠️ O `\b` final FOI REMOVIDO DE PROPÓSITO: mesmo com a flag `u`, o engine do
// Node/V8 trata letras acentuadas PT-BR ('é', 'ç', 'ã') como não-word em alguns
// contextos, e o `\b` final deixa de casar entre "resolvo até" e "amanhã".
// O `\b` no início continua — protege contra matches no meio de palavra ("abrir"
// contém "ri" mas não casa `resolv`).
export const PROMISE_SEMANTIC_FAST_SKIP: RegExp =
  /\b(?:grátis?|gratuita?|graça|de\s+graça|cortesia|de\s+cortesia|sem\s+custo|isento|isentar|isenta|brinde|bônus|bonus|garant(?:o|a|imos|em|ia|ir)|promet(?:o|emos|emos|am|ido)|confirm(?:o|amos|ei|ou|aram|ado)|entreg(?:o|a|amos|aram|uei|ue)\s+(?:amanhã|amanha|hoje|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|domingo)|fica\s+pronto|pronto\s+at[eé]|resolv(?:o|emos|em|eram|ido)\s+at[eé]|faço\s+por|fazemos\s+por|100%\s+de\s+desconto|isent(?:o|a|amos)\s+(?:a\s+|as\s+)?taxa|de\s+brinde)/iu;

/**
 * Helper p/ testes e diagnóstico — aplica o fast-skip num texto.
 * `true` significa "regex casou → chama o classificador LLM pra desambiguar";
 * `false` significa "sem keyword → fast-skip direto".
 */
export function hasPromiseKeyword(candidate: string): boolean {
  return PROMISE_SEMANTIC_FAST_SKIP.test(candidate);
}

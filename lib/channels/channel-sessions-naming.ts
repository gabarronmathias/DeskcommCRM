/**
 * Política de nomes para waha_session_name no onboarding de canais.
 *
 * Investigação 2026-09-04: a org gabarron-mathias tinha um canal com
 * `waha_session_name = "default"` (WAHA Plus bootstrap pré-criou a sessão
 * com esse nome, e o espelhamento aconteceu em versão anterior do
 * onboarding). A correção tem 3 lados:
 *
 *   1. RUNTIME: `lib/channels/session-ref.ts` é fail-closed em
 *      vazio/sentinela de debug (mas NÃO em "default" — é nome real
 *      de uma sessão WAHA Plus legada).
 *   2. PERSISTÊNCIA: este arquivo é o PONTO ÚNICO onde o nome de uma
 *      sessão NOVA é decidido. Se o que veio do banco é um valor
 *      fail-closed, geramos `org_<8hex>`. Se for um nome real (incluindo
 *      "default", que é o nome real da sessão WAHA Plus legacy da
 *      gabarron-mathias), REUSAMOS.
 *   3. CAUSA RAIZ EVITADA: o código nunca PERSISTE "default"/"DEFAULT"
 *      como nome de uma sessão NOVA — porque ele não os gera (gera
 *      `org_<8hex>`) e o helper rejeita esses valores quando o "existing"
 *      vier como placeholder de debug.
 *
 * O conjunto "fail-closed" aqui é o MESMO do `lib/channels/session-ref.ts`:
 * só strings vazias e sentinelas de debug. "default" é nome real.
 */

const PLACEHOLDER_VALUES = new Set(["null", "undefined"]);

/**
 * "Esse nome é um placeholder / sentinel e não deve ser gravado como
 * `waha_session_name` de uma sessão NOVA?"
 *
 * Verdadeiro para: vazio, whitespace, e sentinelas de debug
 * ('null'/'undefined' como string). FALSO para 'default'/'DEFAULT' —
 * que em produção é o nome real de uma sessão WAHA Plus legada
 * (gabarron-mathias, 2026-09-04).
 */
export function isChannelSessionNamePlaceholder(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  // trim() cobre vazio, "   ", "\n", "\t", etc.
  if (value.trim() === "") return true;
  return PLACEHOLDER_VALUES.has(value);
}

/**
 * Resolve o `waha_session_name` que o onboarding vai persistir.
 *
 * 1. Se `existing` for um nome real (não-placeholder), REUSA (a sessão
 *    já está pareada com WAHA, idempotente). "default" entra aqui.
 * 2. Caso contrário (placeholder ou null), GERA `org_<8hex>` a partir
 *    do id da organização. Esse é o nome que o código novo PODE criar
 *    do zero.
 */
export function resolveChannelSessionName(
  existing: string | null | undefined,
  organizationId: string,
): string {
  if (existing && !isChannelSessionNamePlaceholder(existing)) return existing;
  return `org_${organizationId.slice(0, 8)}`;
}

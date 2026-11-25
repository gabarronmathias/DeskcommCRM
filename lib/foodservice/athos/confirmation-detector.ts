/**
 * Detector de confirmacao explicita para o pedido Athos (briefing recovery
 * Athos x Sarah E2E 2026-09-13).
 *
 * Reconhece confirmacoes inequivocas:
 *   "confirmar pedido"
 *   "confirmo"
 *   "pode confirmar"
 *   "fechar pedido"
 *   "pode fechar"
 *   "confirmar"
 *
 * "sim" sozinho NAO conta - so vale se o estado ja for awaiting_confirmation
 * (tratado em runtime-wiring.ts).
 */

export const CONFIRMATION_PHRASES: ReadonlyArray<string> = [
  'confirmar pedido',
  'confirma o pedido',
  'confirmo o pedido',
  'pode confirmar',
  'pode fechar',
  'fechar pedido',
  'confirma',
  'confirmo',
  'pode confirmar o pedido',
  'finalizar pedido',
  'manda ver',
];

const CONFIRMATION_RE = new RegExp(
  `\\b(?:${CONFIRMATION_PHRASES.map(escapeForRegex).join('|')})\\b`,
  'iu',
);

export function detectExplicitConfirmation(text: string): boolean {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?]+$/g, '')
    .trim()
    .toLowerCase();
  if (CONFIRMATION_RE.test(normalized)) return true;
  return /\bconfirmar\b|\bpode fechar\b/i.test(normalized);
}

function escapeForRegex(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

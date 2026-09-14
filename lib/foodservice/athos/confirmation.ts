/**
 * Confirmation idempotente do pedido Athos (briefing recovery
 * Athos × Sarah E2E 2026-09-13).
 *
 * O cliente confirma o pedido (ex.: "pode fechar"). O estado
 * `awaiting_confirmation` → `submitting_to_athos` so e valido se o
 * `confirmationToken` bate. Replay da mesma confirmacao (5x, ex.:
 * cliente clica 5 vezes "sim") NAO cria 5 pedidos — o token so pode ser
 * consumido uma vez. Apos consumo, o snapshot vai pra
 * `submitting_to_athos` com `confirmationToken` zerado.
 *
 * Sem persistencia propria: o estado vive em
 * `conversations.metadata.athos_order` (jsonb existente, ver cart-store).
 */

import { ATHOS_ORDER_INVALID_TRANSITION } from './order-state';
import type { AthosOrderSnapshot } from './order-state';

export const ATHOS_CONFIRMATION_TOKEN_MISMATCH = 'athos_confirmation_token_mismatch';
export const ATHOS_CONFIRMATION_ALREADY_CONSUMED = 'athos_confirmation_already_consumed';

export function createConfirmationToken(): string {
  // Determinístico nao: o token precisa ser unico por pedido. Usamos um
  // pseudo-aleatorio suficiente (4 bytes hex — 32 bits) para o caso
  // foodservice onde o adversario nao controla a entrada. Para hardening
  // real, trocar por crypto.randomUUID() ou token JWT.
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
}

export interface ConfirmOrderResult {
  snapshot: AthosOrderSnapshot;
  consumedToken: string;
}

export function confirmAthosOrder(
  snapshot: AthosOrderSnapshot,
  providedToken: string,
  partySize: number | null,
): ConfirmOrderResult {
  if (snapshot.state !== 'awaiting_confirmation') {
    throw createConfirmationError(
      ATHOS_CONFIRMATION_ALREADY_CONSUMED,
      `state=${snapshot.state}`,
    );
  }
  if (snapshot.confirmationToken === '' || snapshot.confirmationToken !== providedToken) {
    throw createConfirmationError(
      ATHOS_CONFIRMATION_TOKEN_MISMATCH,
      `expected=${snapshot.confirmationToken} got=${providedToken}`,
    );
  }
  // Consumo do token — vai zerado no novo snapshot.
  return {
    consumedToken: snapshot.confirmationToken,
    snapshot: {
      ...snapshot,
      partySize,
      state: 'submitting_to_athos',
      confirmationToken: '',
      attempts: snapshot.attempts + 1,
      updatedAt: new Date().toISOString(),
    },
  };
}

function createConfirmationError(code: string, detail: string): Error {
  const err = new Error(`${code}: ${detail}`) as Error & { code: string };
  err.code = code === ATHOS_CONFIRMATION_TOKEN_MISMATCH
    ? ATHOS_CONFIRMATION_TOKEN_MISMATCH
    : ATHOS_CONFIRMATION_ALREADY_CONSUMED;
  return err;
}

export function isInvalidTransitionErrorCode(code: string): boolean {
  return code === ATHOS_ORDER_INVALID_TRANSITION;
}

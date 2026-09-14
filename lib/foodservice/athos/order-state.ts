/**
 * State machine do pedido Athos (briefing recovery Athos × Sarah E2E 2026-09-13).
 *
 * O estado de cada pedido de comida foodservice é guardado em
 * `conversations.metadata.athos_order` (jsonb existente — sem migration).
 * Transições válidas são as listadas em `ATHOS_ORDER_TRANSITIONS`; qualquer
 * outra transição levanta `ATHOS_ORDER_INVALID_TRANSITION` (não é mutação
 * silenciosa).
 *
 * Estados:
 *   awaiting_confirmation    — Sarah disse "fecho assim?"; esperando "sim"/"pode
 *                              ser" do cliente antes de chamar o adapter.
 *   submitting_to_athos      — cliente confirmou; adapter Athos order-write
 *                              em curso (pode falhar com
 *                              ATHOS_ORDER_WRITE_UNAVAILABLE — boundary externo).
 *   athos_created            — adapter Athos respondeu com external_order_id;
 *                              CRM mirror ainda não gravado.
 *   crm_recorded             — orders + food_order_items gravados; espelho
 *                              completo no CRM.
 *   completed                — enviado para o cliente; pedido confirmado.
 *   reconciliation_required  — falha detectada após `athos_created` (sem
 *                              `crm_recorded`); o worker de recovery precisa
 *                              refazer o mirror OU o `submitting_to_athos`
 *                              (idempotência pela chave externa garante 1
 *                              pedido Athos).
 *
 * Ver testes:
 *   - tests/unit/athos-order-state.test.ts
 *   - tests/unit/athos-order-replay.test.ts
 *   - tests/unit/athos-order-recovery.test.ts
 */

export type AthosOrderState =
  | 'awaiting_confirmation'
  | 'submitting_to_athos'
  | 'athos_created'
  | 'crm_recorded'
  | 'completed'
  | 'reconciliation_required';

const ATHOS_ORDER_TRANSITIONS: Readonly<Record<AthosOrderState, ReadonlyArray<AthosOrderState>>> = {
  awaiting_confirmation: ['submitting_to_athos'],
  submitting_to_athos: ['athos_created', 'crm_recorded', 'reconciliation_required'],
  athos_created: ['crm_recorded', 'reconciliation_required'],
  crm_recorded: ['completed'],
  completed: [],
  reconciliation_required: ['submitting_to_athos', 'crm_recorded'],
};

export const ATHOS_ORDER_INVALID_TRANSITION = 'athos_order_invalid_transition';

export interface AthosOrderSnapshot {
  state: AthosOrderState;
  confirmationToken: string;
  partySize: number | null;
  cartItems: ReadonlyArray<AthosCartItem>;
  externalOrderId: string | null;
  crmOrderId: string | null;
  updatedAt: string;
  attempts: number;
  lastError: string | null;
}

export interface AthosCartItem {
  externalProductId: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  modifiers: ReadonlyArray<{ name: string; priceDeltaCents: number }>;
}

export function emptyAthosOrderSnapshot(): AthosOrderSnapshot {
  return {
    state: 'awaiting_confirmation',
    confirmationToken: '',
    partySize: null,
    cartItems: [],
    externalOrderId: null,
    crmOrderId: null,
    updatedAt: new Date(0).toISOString(),
    attempts: 0,
    lastError: null,
  };
}

export function transitionAthosOrder(
  snapshot: AthosOrderSnapshot,
  next: AthosOrderState,
  patch: Partial<AthosOrderSnapshot> = {},
): AthosOrderSnapshot {
  const allowed = ATHOS_ORDER_TRANSITIONS[snapshot.state];
  if (!allowed.includes(next)) {
    throw createAthosTransitionError(snapshot.state, next);
  }
  return {
    ...snapshot,
    ...patch,
    state: next,
    updatedAt: new Date().toISOString(),
  };
}

export function canTransitionAthosOrder(from: AthosOrderState, to: AthosOrderState): boolean {
  return ATHOS_ORDER_TRANSITIONS[from].includes(to);
}

function createAthosTransitionError(from: AthosOrderState, to: AthosOrderState): Error {
  const err = new Error(
    `${ATHOS_ORDER_INVALID_TRANSITION}: ${from} -> ${to} nao permitido`,
  ) as Error & { code: string; from: AthosOrderState; to: AthosOrderState };
  err.code = ATHOS_ORDER_INVALID_TRANSITION;
  err.from = from;
  err.to = to;
  return err;
}

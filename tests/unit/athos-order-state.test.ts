/**
 * State machine do pedido Athos (briefing recovery Athos × Sarah E2E 2026-09-13).
 *
 * Cobertura:
 *   - transicoes validas (happy path)
 *   - transicoes invalidas levantam ATHOS_ORDER_INVALID_TRANSITION
 *   - reconciliation_required re-roteia submitting_to_athos / crm_recorded
 *   - completed e estado terminal
 */
import { describe, expect, it } from 'vitest';

import {
  ATHOS_ORDER_INVALID_TRANSITION,
  canTransitionAthosOrder,
  emptyAthosOrderSnapshot,
  transitionAthosOrder,
} from '../../lib/foodservice/athos/order-state';

describe('athos-order-state (briefing recovery)', () => {
  it('happy path: awaiting_confirmation -> submitting_to_athos -> athos_created -> crm_recorded -> completed', () => {
    const a = emptyAthosOrderSnapshot();
    expect(a.state).toBe('awaiting_confirmation');

    const b = transitionAthosOrder(a, 'submitting_to_athos', { partySize: 6 });
    expect(b.state).toBe('submitting_to_athos');
    expect(b.partySize).toBe(6);

    const c = transitionAthosOrder(b, 'athos_created', { externalOrderId: 'athos-001' });
    expect(c.state).toBe('athos_created');
    expect(c.externalOrderId).toBe('athos-001');

    const d = transitionAthosOrder(c, 'crm_recorded', { crmOrderId: 'crm-001' });
    expect(d.state).toBe('crm_recorded');
    expect(d.crmOrderId).toBe('crm-001');

    const e = transitionAthosOrder(d, 'completed');
    expect(e.state).toBe('completed');
    expect(completedTerminal(e.state)).toBe(true);
  });

  it('happy path alternativo: submitting_to_athos -> crm_recorded (idempotencia)', () => {
    const a = emptyAthosOrderSnapshot();
    const b = transitionAthosOrder(a, 'submitting_to_athos', { partySize: 4 });
    const c = transitionAthosOrder(b, 'crm_recorded', {
      crmOrderId: 'crm-direct',
      externalOrderId: 'athos-direct',
    });
    expect(c.state).toBe('crm_recorded');
  });

  it('transicao invalida levanta ATHOS_ORDER_INVALID_TRANSITION', () => {
    const a = emptyAthosOrderSnapshot();
    expect(() => transitionAthosOrder(a, 'completed')).toThrowError(ATHOS_ORDER_INVALID_TRANSITION);
  });

  it('transicao invalida NAO e mutacao silenciosa', () => {
    const a = emptyAthosOrderSnapshot();
    try {
      transitionAthosOrder(a, 'completed');
    } catch (err) {
      const code = (err as { code: string }).code;
      expect(code).toBe(ATHOS_ORDER_INVALID_TRANSITION);
    }
    expect(a.state).toBe('awaiting_confirmation');
  });

  it('reconciliation_required re-roteia para submitting_to_athos e crm_recorded', () => {
    const a = emptyAthosOrderSnapshot();
    const b = transitionAthosOrder(a, 'submitting_to_athos', { partySize: 8 });
    const c = transitionAthosOrder(b, 'reconciliation_required', {
      lastError: 'athos timeout',
      attempts: 1,
    });
    expect(c.state).toBe('reconciliation_required');

    const d = transitionAthosOrder(c, 'submitting_to_athos', { attempts: 2 });
    expect(d.state).toBe('submitting_to_athos');

    const e = transitionAthosOrder(d, 'crm_recorded', { crmOrderId: 'crm-002' });
    expect(e.state).toBe('crm_recorded');
  });

  it('canTransitionAthosOrder responde o mesmo que transitionAthosOrder aceita', () => {
    expect(canTransitionAthosOrder('awaiting_confirmation', 'submitting_to_athos')).toBe(true);
    expect(canTransitionAthosOrder('awaiting_confirmation', 'completed')).toBe(false);
    expect(canTransitionAthosOrder('completed', 'submitting_to_athos')).toBe(false);
  });
});

function completedTerminal(state: string): boolean {
  return state === 'completed';
}

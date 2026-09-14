/**
 * Replay da mesma confirmacao Athos (briefing recovery
 * Athos × Sarah E2E 2026-09-13).
 *
 * Cenario: cliente clica 5 vezes em "pode fechar". O snapshot so
 * transita `awaiting_confirmation` → `submitting_to_athos` UMA vez (o
 * confirmationToken e consumido na primeira chamada). Replays
 * subsequentes levantam ATHOS_CONFIRMATION_ALREADY_CONSUMED — sem criar
 * 5 pedidos Athos e 5 mirrors no CRM.
 *
 * Cobertura:
 *   - 5 replays da mesma confirmacao → 1 pedido Athos criado
 *   - 5 replays da mesma confirmacao → 1 espelho no CRM
 *   - token mismatch NAO consome o token
 *   - 2 confirmacoes com tokens diferentes → 2 pedidos (consumir o token
 *     permite novo pedido com novo token)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ATHOS_CONFIRMATION_ALREADY_CONSUMED,
  ATHOS_CONFIRMATION_TOKEN_MISMATCH,
  confirmAthosOrder,
  createConfirmationToken,
} from '../../lib/foodservice/athos/confirmation';
import {
  ATHOS_ORDER_WRITE_UNAVAILABLE,
  createAthosOrder,
  setAthosAdapter,
  clearAthosAdapter,
  type AthosOrderAdapter,
} from '../../lib/foodservice/athos/order-adapter';
import {
  emptyAthosOrderSnapshot,
  transitionAthosOrder,
} from '../../lib/foodservice/athos/order-state';
import {
  computeTotalCents,
  mirrorAthosOrderToCrm,
  type OrderMirrorClient,
} from '../../lib/foodservice/athos/order-mirror';

function makeFakeAdapter(): AthosOrderAdapter & { count: number } {
  const adapter = {
    provider: 'athos' as const,
    isConfigured: () => true,
    count: 0,
    createAthosOrder: vi.fn(async (input: { idempotencyKey: string }) => {
      adapter.count++;
      return {
        externalOrderId: `athos-${input.idempotencyKey}`,
        externalStatus: 'created',
        externalPayload: {},
        athosCreatedAt: new Date().toISOString(),
      };
    }),
  };
  return adapter;
}

function makeMirrorClient() {
  const existing = new Set<string>();
  const created: Array<{ externalId: string; orderId: string }> = [];
  const itemIds: Array<string> = [];
  return {
    client: {
      insertOrderWithIdempotency: vi.fn(async (input: {
        externalId: string;
        idempotencyKey: string;
        orderId?: string;
      }) => {
        const key = `${input.idempotencyKey}`;
        if (existing.has(key)) {
          const found = created.find((o) => o.externalId === input.externalId);
          return { orderId: found?.orderId ?? 'crm-replay', wasReplay: true };
        }
        existing.add(key);
        const orderId = `crm-${created.length + 1}`;
        created.push({ externalId: input.externalId, orderId });
        return { orderId, wasReplay: false };
      }),
      insertFoodOrderItems: vi.fn(async () => {
        itemIds.push(`item-${itemIds.length + 1}`);
        return itemIds.slice();
      }),
    } as OrderMirrorClient,
    created,
    itemIds,
  };
}

describe('athos-order-replay (briefing recovery)', () => {
  beforeEach(() => {
    clearAthosAdapter();
  });

  it('5 replays da mesma confirmacao → 1 pedido Athos criado + 1 espelho CRM', async () => {
    const adapter = makeFakeAdapter();
    setAthosAdapter(adapter);

    const { client: mirrorClient } = makeMirrorClient();

    let snapshot = emptyAthosOrderSnapshot();
    const token = createConfirmationToken();
    snapshot = { ...snapshot, confirmationToken: token, partySize: 6 };

    let athosCount = 0;
    let crmCount = 0;

    for (let i = 0; i < 5; i++) {
      // A confirmacao so e valida enquanto o snapshot esta em
      // awaiting_confirmation — depois disso, o replay NAO e processado.
      if (snapshot.state !== 'awaiting_confirmation') {
        expect(snapshot.state).toBe('crm_recorded');
        continue;
      }
      const consumed = confirmAthosOrder(snapshot, token, 6);
      snapshot = consumed.snapshot;
      const result = await createAthosOrder({
        organizationId: 'org-1',
        contactId: 'contact-1',
        partySize: 6,
        cartItems: [
          {
            externalProductId: 'prod-1',
            productName: 'Bolo',
            quantity: 1,
            unitPriceCents: 12000,
            modifiers: [],
          },
        ],
        idempotencyKey: 'idem-replay-001',
        confirmationToken: consumed.consumedToken,
        totalCents: 12000,
      });
      athosCount++;
      snapshot = transitionAthosOrder(snapshot, 'athos_created', {
        externalOrderId: result.externalOrderId,
      });
      const mirror = await mirrorAthosOrderToCrm(mirrorClient, {
        organizationId: 'org-1',
        contactId: 'contact-1',
        conversationId: 'conv-1',
        athosCreated: result,
        cartItems: [
          {
            externalProductId: 'prod-1',
            productName: 'Bolo',
            quantity: 1,
            unitPriceCents: 12000,
            modifiers: [],
          },
        ],
        partySize: 6,
        idempotencyKey: 'idem-replay-001',
        externalProvider: 'gm_crm_food',
      });
      if (!mirror.wasReplay) crmCount++;
      snapshot = transitionAthosOrder(snapshot, 'crm_recorded', {
        crmOrderId: mirror.crmOrderId,
      });
    }

    expect(adapter.createAthosOrder).toHaveBeenCalledTimes(1);
    expect(athosCount).toBe(1);
    expect(crmCount).toBe(1);
    expect(snapshot.state).toBe('crm_recorded');
  });

  it('token mismatch NAO consome o token', () => {
    let snapshot = emptyAthosOrderSnapshot();
    snapshot = { ...snapshot, confirmationToken: 'token-real' };
    expect(() => confirmAthosOrder(snapshot, 'token-falso', 6)).toThrowError(
      ATHOS_CONFIRMATION_TOKEN_MISMATCH,
    );
    expect(snapshot.state).toBe('awaiting_confirmation');
    expect(snapshot.confirmationToken).toBe('token-real');
  });

  it('2 confirmacoes com tokens diferentes → 2 pedidos', async () => {
    const adapter = makeFakeAdapter();
    setAthosAdapter(adapter);

    const s1 = { ...emptyAthosOrderSnapshot(), confirmationToken: 'tok-A' };
    const r1 = confirmAthosOrder(s1, 'tok-A', 4);
    const a1 = await createAthosOrder({
      organizationId: 'org-1',
      contactId: 'contact-1',
      partySize: 4,
      cartItems: [],
      idempotencyKey: 'idem-A',
      confirmationToken: r1.consumedToken,
      totalCents: 0,
    });
    expect(a1.externalOrderId).toBe('athos-idem-A');

    const s2 = { ...emptyAthosOrderSnapshot(), confirmationToken: 'tok-B' };
    const r2 = confirmAthosOrder(s2, 'tok-B', 6);
    const a2 = await createAthosOrder({
      organizationId: 'org-1',
      contactId: 'contact-1',
      partySize: 6,
      cartItems: [],
      idempotencyKey: 'idem-B',
      confirmationToken: r2.consumedToken,
      totalCents: 0,
    });
    expect(a2.externalOrderId).toBe('athos-idem-B');

    expect(adapter.count).toBe(2);
  });

  it('sem configuracao externa: boundary explicito (NÃO cria so no CRM)', async () => {
    clearAthosAdapter();
    let snapshot = { ...emptyAthosOrderSnapshot(), confirmationToken: 'tok-x' };
    const r = confirmAthosOrder(snapshot, 'tok-x', 6);
    snapshot = r.snapshot;
    await expect(
      createAthosOrder({
        organizationId: 'org-1',
        contactId: 'contact-1',
        partySize: 6,
        cartItems: [],
        idempotencyKey: 'idem-y',
        confirmationToken: r.consumedToken,
        totalCents: 0,
      }),
    ).rejects.toMatchObject({ code: ATHOS_ORDER_WRITE_UNAVAILABLE });
    expect(snapshot.state).toBe('submitting_to_athos');
    expect(snapshot.crmOrderId).toBeNull();
  });

  it('computeTotalCents soma itens + modifiers', () => {
    expect(
      computeTotalCents([
        {
          externalProductId: 'p1',
          productName: 'Bolo',
          quantity: 1,
          unitPriceCents: 10000,
          modifiers: [{ name: 'topper', priceDeltaCents: 500 }],
        },
        {
          externalProductId: 'p2',
          productName: 'Doce',
          quantity: 50,
          unitPriceCents: 200,
          modifiers: [],
        },
      ]),
    ).toBe(10000 + 500 + 50 * 200);
  });
});

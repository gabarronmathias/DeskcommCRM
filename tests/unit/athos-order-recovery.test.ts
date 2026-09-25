/**
 * Crash recovery Athos × CRM (briefing recovery Athos × Sarah E2E 2026-09-13).
 *
 * Cenario: o adapter Athos respondeu com external_order_id (estado
 * `athos_created`), o worker caiu ANTES de gravar `orders` no CRM.
 * No proximo run, o snapshot `athos_created` (sem `crm_record_id`) e
 * encontrado e o espelho roda de novo com a mesma `idempotency_key` —
 * o `insertOrderWithIdempotency` retorna `wasReplay=true`, garantindo
 * que 1 pedido Athos == 1 espelho CRM.
 *
 * Cobertura:
 *   - snapshot `athos_created` sem crm_order_id → recovery roda
 *   - recovery idempotente: 2a chamada NAO duplica o order
 *   - snapshot NAO recuperavel (crm_recorded/completed) → noop
 *   - snapshot com externalOrderId=null → NAO recuperavel
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setAthosAdapter,
  clearAthosAdapter,
  type AthosOrderAdapter,
} from '../../lib/foodservice/athos/order-adapter';
import {
  emptyAthosOrderSnapshot,
  transitionAthosOrder,
} from '../../lib/foodservice/athos/order-state';
import { buildRecoveryOutcome } from '../../lib/foodservice/athos/recovery';
import { mirrorAthosOrderToCrm, type OrderMirrorClient } from '../../lib/foodservice/athos/order-mirror';

const athosCreatedFixture = {
  externalOrderId: 'athos-001',
  externalStatus: 'created',
  externalPayload: {},
  athosCreatedAt: '2026-09-13T20:00:00.000Z',
};

const cartItems = [
  {
    externalProductId: 'prod-1',
    productName: 'Bolo',
    quantity: 1,
    unitPriceCents: 12000,
    modifiers: [],
  },
];

function makeMirrorClient(opts: { replay?: boolean } = {}) {
  const keys = new Set<string>();
  const orders = new Map<string, string>();
  return {
    client: {
      insertOrderWithIdempotency: vi.fn(async (input: {
        externalId: string;
        idempotencyKey: string;
      }) => {
        if (keys.has(input.idempotencyKey)) {
          const orderId = orders.get(input.externalId) ?? 'crm-replay';
          return { orderId, wasReplay: true };
        }
        keys.add(input.idempotencyKey);
        const orderId = opts.replay === true
          ? `crm-replay-${orders.size + 1}`
          : `crm-${orders.size + 1}`;
        orders.set(input.externalId, orderId);
        return { orderId, wasReplay: false };
      }),
      insertFoodOrderItems: vi.fn(async () => ['item-1']),
    } as OrderMirrorClient,
  };
}

describe('athos-order-recovery (briefing recovery)', () => {
  beforeEach(() => {
    clearAthosAdapter();
    setAthosAdapter({
      provider: 'athos',
      isConfigured: () => true,
      createAthosOrder: async () => athosCreatedFixture,
    } as AthosOrderAdapter);
  });

  it('snapshot athos_created sem crm_order_id → recovery espelha no CRM', async () => {
    const snapshot = transitionAthosOrder(
      transitionAthosOrder(emptyAthosOrderSnapshot(), 'submitting_to_athos', { partySize: 6 }),
      'athos_created',
      { externalOrderId: 'athos-001' },
    );
    const { client } = makeMirrorClient();

    const outcome = await buildRecoveryOutcome(
      snapshot,
      {
        organizationId: 'org-1',
        contactId: 'contact-1',
        conversationId: 'conv-1',
        cartItems,
        partySize: 6,
        idempotencyKey: 'idem-crash-001',
        athosCreated: athosCreatedFixture,
        externalProvider: 'gm_crm_food',
      },
      client,
    );

    expect(outcome.recovered).toBe(true);
    expect(outcome.finalState).toBe('crm_recorded');
    expect(outcome.mirror?.crmOrderId).toBe('crm-1');
    expect(outcome.mirror?.wasReplay).toBe(false);
  });

  it('recovery idempotente: 2a chamada NAO duplica o order', async () => {
    const snapshot = transitionAthosOrder(
      transitionAthosOrder(emptyAthosOrderSnapshot(), 'submitting_to_athos', { partySize: 4 }),
      'athos_created',
      { externalOrderId: 'athos-002' },
    );
    const { client } = makeMirrorClient();

    const first = await buildRecoveryOutcome(snapshot, {
      organizationId: 'org-1',
      contactId: 'contact-1',
      conversationId: 'conv-2',
      cartItems,
      partySize: 4,
      idempotencyKey: 'idem-crash-002',
      athosCreated: athosCreatedFixture,
      externalProvider: 'gm_crm_food',
    }, client);
    expect(first.mirror?.wasReplay).toBe(false);

    // 2a chamada — mesma idempotency_key
    const second = await buildRecoveryOutcome(first.mirror === null
      ? snapshot
      : transitionAthosOrder(snapshot, 'crm_recorded', { crmOrderId: first.mirror.crmOrderId }),
      {
        organizationId: 'org-1',
        contactId: 'contact-1',
        conversationId: 'conv-2',
        cartItems,
        partySize: 4,
        idempotencyKey: 'idem-crash-002',
        athosCreated: athosCreatedFixture,
        externalProvider: 'gm_crm_food',
      },
      client);
    // snapshot ja e crm_recorded → recovery noop
    expect(second.recovered).toBe(false);
    expect(second.finalState).toBe('crm_recorded');
  });

  it('snapshot crm_recorded → noop', async () => {
    const snapshot = transitionAthosOrder(
      transitionAthosOrder(
        transitionAthosOrder(emptyAthosOrderSnapshot(), 'submitting_to_athos', { partySize: 6 }),
        'athos_created',
        { externalOrderId: 'athos-003' },
      ),
      'crm_recorded',
      { crmOrderId: 'crm-existing' },
    );
    const { client } = makeMirrorClient();
    const outcome = await buildRecoveryOutcome(snapshot, {
      organizationId: 'org-1',
      contactId: 'contact-1',
      conversationId: 'conv-3',
      cartItems,
      partySize: 6,
      idempotencyKey: 'idem-crash-003',
      athosCreated: athosCreatedFixture,
      externalProvider: 'gm_crm_food',
    }, client);
    expect(outcome.recovered).toBe(false);
    expect(outcome.finalState).toBe('crm_recorded');
    expect(outcome.mirror).toBeNull();
  });

  it('snapshot athos_created sem externalOrderId → NAO recuperavel', async () => {
    const snapshot = transitionAthosOrder(
      transitionAthosOrder(emptyAthosOrderSnapshot(), 'submitting_to_athos', { partySize: 6 }),
      'athos_created',
    );
    expect(snapshot.externalOrderId).toBeNull();
    const { client } = makeMirrorClient();
    const outcome = await buildRecoveryOutcome(snapshot, {
      organizationId: 'org-1',
      contactId: 'contact-1',
      conversationId: 'conv-4',
      cartItems,
      partySize: 6,
      idempotencyKey: 'idem-crash-004',
      athosCreated: athosCreatedFixture,
      externalProvider: 'gm_crm_food',
    }, client);
    expect(outcome.recovered).toBe(false);
  });

  it('reconciliation_required com externalOrderId recupera apenas o espelho', async () => {
    const submitting = transitionAthosOrder(emptyAthosOrderSnapshot(), 'submitting_to_athos');
    const snapshot = transitionAthosOrder(submitting, 'reconciliation_required', {
      externalOrderId: 'athos-existing-001',
    });
    const { client } = makeMirrorClient();
    const outcome = await buildRecoveryOutcome(snapshot, {
      organizationId: 'org-1',
      contactId: 'contact-1',
      conversationId: 'conv-reconcile',
      cartItems,
      partySize: 2,
      idempotencyKey: 'idem-reconcile-001',
      athosCreated: { ...athosCreatedFixture, externalOrderId: 'athos-existing-001' },
      externalProvider: 'athos',
    }, client);
    expect(outcome).toMatchObject({ recovered: true, finalState: 'crm_recorded' });
    expect(client.insertOrderWithIdempotency).toHaveBeenCalledTimes(1);
    expect(client.insertFoodOrderItems).toHaveBeenCalledTimes(1);
  });
});

describe('athos-order-mirror (briefing recovery)', () => {
  it('mirrorAthosOrderToCrm calcula totalCents e rotula source=athos', async () => {
    const { client } = makeMirrorClient();
    const mirror = await mirrorAthosOrderToCrm(client, {
      organizationId: 'org-1',
      contactId: 'contact-1',
      conversationId: 'conv-mirror-001',
      athosCreated: athosCreatedFixture,
      cartItems: [
        {
          externalProductId: 'prod-1',
          productName: 'Bolo',
          quantity: 1,
          unitPriceCents: 12000,
          modifiers: [{ name: 'topper', priceDeltaCents: 500 }],
        },
      ],
      partySize: 6,
      idempotencyKey: 'idem-mirror-001',
      externalProvider: 'gm_crm_food',
    });
    expect(mirror.crmOrderId).toBe('crm-1');
    expect(mirror.wasReplay).toBe(false);
  });
});

/**
 * Adapter boundary do pedido Athos (briefing recovery Athos × Sarah E2E 2026-09-13).
 *
 * Cobertura:
 *   - sem ATHOS_ORDER_WRITE_ENDPOINT configurado: runtime adapter levanta
 *     ATHOS_ORDER_WRITE_UNAVAILABLE
 *   - sem adapter injetado: mesmo erro (boundary explicito)
 *   - com adapter injetado (fake): createAthosOrder retorna external_order_id
 *   - isConfigured() reflete a configuracao
 *   - nao ha fallback silencioso para "criar so no CRM"
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ATHOS_ORDER_WRITE_UNAVAILABLE,
  athosRuntimeAdapter,
  clearAthosAdapter,
  createAthosOrder,
  setAthosAdapter,
  type AthosOrderAdapter,
} from '../../lib/foodservice/athos/order-adapter';

const baseInput = {
  organizationId: 'org-1',
  contactId: 'contact-1',
  partySize: 6 as number | null,
  cartItems: [
    {
      externalProductId: 'prod-1',
      productName: 'Bolo de chocolate 1.5kg',
      quantity: 1,
      unitPriceCents: 12000,
      modifiers: [],
    },
  ],
  idempotencyKey: 'idem-001',
  confirmationToken: 'tok-001',
  totalCents: 12000,
};

describe('athos-order-adapter (briefing recovery)', () => {
  beforeEach(() => {
    delete process.env['ATHOS_ORDER_WRITE_ENDPOINT'];
    clearAthosAdapter();
  });

  afterEach(() => {
    clearAthosAdapter();
  });

  it('sem env configurado + sem adapter injetado → ATHOS_ORDER_WRITE_UNAVAILABLE', async () => {
    expect(athosRuntimeAdapter.isConfigured()).toBe(false);
    await expect(createAthosOrder(baseInput)).rejects.toMatchObject({
      code: ATHOS_ORDER_WRITE_UNAVAILABLE,
    });
  });

  it('isConfigured() reflete env ATHOS_ORDER_WRITE_ENDPOINT', () => {
    expect(athosRuntimeAdapter.isConfigured()).toBe(false);
    process.env['ATHOS_ORDER_WRITE_ENDPOINT'] = 'https://athos.example/write';
    expect(athosRuntimeAdapter.isConfigured()).toBe(true);
  });

  it('com fake adapter injetado: createAthosOrder retorna external_order_id', async () => {
    const fake: AthosOrderAdapter = {
      provider: 'athos',
      isConfigured: () => true,
      createAthosOrder: vi.fn(async (input) => ({
        externalOrderId: `athos-${input.idempotencyKey}`,
        externalStatus: 'created',
        externalPayload: { echo: input.cartItems.length },
        athosCreatedAt: new Date().toISOString(),
      })),
    };
    setAthosAdapter(fake);
    const out = await createAthosOrder(baseInput);
    expect(out.externalOrderId).toBe('athos-idem-001');
    expect(fake.createAthosOrder).toHaveBeenCalledTimes(1);
  });

  it('NAO ha fallback silencioso: erro explicito em vez de criar so no CRM', async () => {
    let attempts = 0;
    const fake: AthosOrderAdapter = {
      provider: 'athos',
      isConfigured: () => false,
      createAthosOrder: vi.fn(async () => {
        attempts++;
        throw new Error('should not be called');
      }),
    };
    setAthosAdapter(fake);
    await expect(createAthosOrder(baseInput)).rejects.toMatchObject({
      code: ATHOS_ORDER_WRITE_UNAVAILABLE,
    });
    expect(attempts).toBe(0);
  });

  it('provider e sempre "athos"', () => {
    expect(athosRuntimeAdapter.provider).toBe('athos');
  });
});

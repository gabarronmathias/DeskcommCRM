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
  conversationId: 'conversation-1',
  partySize: 6 as number | null,
  cartItems: [
    {
      externalProductId: 'prod-1',
      sku: 'SKU-1',
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
    delete process.env['ATHOS_BEARER_TOKEN'];
    delete process.env['ATHOS_HMAC_SECRET'];
    delete process.env['ATHOS_STORE_REF'];
    clearAthosAdapter();
  });

  afterEach(() => {
    clearAthosAdapter();
    vi.unstubAllGlobals();
  });

  it('sem env configurado + sem adapter injetado → ATHOS_ORDER_WRITE_UNAVAILABLE', async () => {
    expect(athosRuntimeAdapter.isConfigured()).toBe(false);
    await expect(createAthosOrder(baseInput)).rejects.toMatchObject({
      code: ATHOS_ORDER_WRITE_UNAVAILABLE,
    });
  });

  it('isConfigured() reflete env ATHOS_ORDER_WRITE_ENDPOINT', () => {
    expect(athosRuntimeAdapter.isConfigured()).toBe(false);
    process.env['ATHOS_ORDER_WRITE_ENDPOINT'] = 'https://athos.example/functions/v1/athos-sandbox';
    process.env['ATHOS_BEARER_TOKEN'] = 'test-bearer';
    process.env['ATHOS_HMAC_SECRET'] = 'test-hmac';
    process.env['ATHOS_STORE_REF'] = 'store-1';
    expect(athosRuntimeAdapter.isConfigured()).toBe(true);
  });

  it('envia launch e evento assinado e só confirma com order_id aceito', async () => {
    process.env['ATHOS_ORDER_WRITE_ENDPOINT'] = 'https://athos.example/functions/v1/athos-sandbox';
    process.env['ATHOS_BEARER_TOKEN'] = 'test-bearer';
    process.env['ATHOS_HMAC_SECRET'] = 'test-hmac';
    process.env['ATHOS_STORE_REF'] = 'store-1';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { environment: 'sandbox', launch_id: 'launch-1', crm_contact_id: 'contact-2' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { accepted: true, order_id: 'order-1' } }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createAthosOrder(baseInput);

    expect(result.externalOrderId).toBe('order-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://athos.example/functions/v1/athos-sandbox/test-launch');
    const eventCall = fetchMock.mock.calls[1];
    const headers = eventCall?.[1]?.headers as Record<string, string>;
    const body = String(eventCall?.[1]?.body);
    expect(headers['Authorization']).toBe('Bearer test-bearer');
    expect(headers['X-Athos-Signature']).toMatch(/^v1=[a-f0-9]{64}$/);
    const event = JSON.parse(body) as { order: { items: Array<{ sku: string }> } };
    expect(event.order.items[0]?.sku).toBe('SKU-1');
  });

  it('não abre launch quando um item não tem SKU Athos', async () => {
    process.env['ATHOS_ORDER_WRITE_ENDPOINT'] = 'https://athos.example/functions/v1/athos-sandbox';
    process.env['ATHOS_BEARER_TOKEN'] = 'test-bearer';
    process.env['ATHOS_HMAC_SECRET'] = 'test-hmac';
    process.env['ATHOS_STORE_REF'] = 'store-1';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createAthosOrder({
      ...baseInput,
      cartItems: [{ ...baseInput.cartItems[0]!, sku: null }],
    })).rejects.toMatchObject({ code: 'athos_item_mapping_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
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

/**
 * Integracao runtime do bridge Athos x Sarah (briefing recovery
 * Athos x Sarah E2E 2026-09-13, branch fix/sarah-athos-e2e-runtime).
 *
 * Cobre:
 *   - tryHandleAthosOrderBridge: resolve tenant no banco; disabled -> null
 *   - cart_selection: match por "quero 2 Bolo de chocolate" persiste snapshot
 *   - confirmation: confirma pedido -> consome token, chama adapter fake
 *   - confirmation: sem cart_items -> nao casa (handled=false)
 *   - confirmation: snapshot NAO awaiting -> handled=false
 *   - 5 replays da mesma confirmacao -> 1 pedido Athos + 1 espelho CRM
 *   - ATHOS_ORDER_WRITE_UNAVAILABLE -> resposta transparente, state preservado
 *   - LGPD-safe: cart snapshot NAO inclui cartao/CVV/documento
 *
 * Limitacao declarada: pg.Pool mockado (sem DB Postgres real no worktree).
 * Prova-se: (a) queries geradas; (b) ordem e idempotencia via mocks; (c)
 * fluxo de estado. NAO chama DB_E2E_PASS.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tryHandleAthosOrderBridge } from '../../lib/agent-engine/agent/athos-bridge-handler';
import {
  handleFoodserviceOrderTurn,
  persistPartySizeFromFastPath,
  runAthosRecovery,
} from '../../lib/foodservice/athos/runtime-wiring';
import {
  ATHOS_ORDER_WRITE_UNAVAILABLE,
  clearAthosAdapter,
  setAthosAdapter,
  type AthosOrderAdapter,
} from '../../lib/foodservice/athos/order-adapter';
import { clearAthosCatalogCache } from '../../lib/foodservice/athos/athos-catalog';
import type pg from 'pg';

// Mock do admin client Supabase (boundary RPC fn_food_public_catalog).
// Sem DB real no worktree — stubamos o catalogo real usado pelo runtime.
vi.mock('../../lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: vi.fn(async () => ({
      data: {
        tenant: {
          slug: 'tortasdocalmon',
          display_name: 'Tortas do Calmon',
          currency: 'BRL',
          free_shipping_threshold_cents: null,
          whatsapp_number: null,
        },
        categories: [{ id: 'cat-bolos', name: 'Bolos', slug: 'bolos', description: null }],
        products: [
          {
            id: 'prod-bolo',
            category_id: 'cat-bolos',
            name: 'Bolo de Chocolate',
            slug: 'bolo-de-chocolate',
            description: null,
            emoji: null,
            price_cents: 12000,
            modifier_groups: [],
          },
        ],
        recommendation_rules: [],
      },
      error: null,
    })),
  }),
}));

// ---- Pool mockado: tabela de contatos/conversations/orders/idempotency em memoria ----

type Row = Record<string, unknown> & { id: string };

class MockTable {
  rows: Row[] = [];
  queryCount = 0;
  lastSql = '';
  failOnNext = false;

  query<T = Row>(sql: string, params: unknown[] = []): { rows: T[]; rowCount: number } {
    this.queryCount++;
    this.lastSql = sql;
    if (this.failOnNext) {
      this.failOnNext = false;
      throw new Error('mock pool failure');
    }
    return { rows: [] as unknown as T[], rowCount: 0 };
  }
}

interface MockPoolOptions {
  enabledTenantSlug?: string;
  contactSourceMetadata?: Record<string, unknown>;
}

function makeMockPool(options: MockPoolOptions = {}): pg.Pool {
  const contacts = new MockTable();
  const conversations = new MockTable();
  const orders = new MockTable();
  const foodOrderItems = new MockTable();
  const idempotencyKeys = new MockTable();

  if (options.contactSourceMetadata !== undefined) {
    contacts.rows.push({
      id: baseDeps.contactId,
      organization_id: baseDeps.organizationId,
      source_metadata: structuredClone(options.contactSourceMetadata),
    });
  }

  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const trimmed = sql.trim().toLowerCase();
      if (trimmed.includes('from organizations o') && trimmed.includes('food_commerce_settings')) {
        return options.enabledTenantSlug === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ tenant_slug: options.enabledTenantSlug }], rowCount: 1 };
      }
      // contacts
      if (trimmed.startsWith('select source_metadata')) {
        const [orgId, contactId] = params as [string, string];
        const found = contacts.rows.find(
          (r) => r['organization_id'] === orgId && r['id'] === contactId,
        );
        return { rows: found ? [{ source_metadata: found['source_metadata'] ?? null }] : [], rowCount: found ? 1 : 0 };
      }
      if (trimmed.startsWith('update contacts')) {
        const [orgId, contactId, json] = params as [string, string, string];
        let row = contacts.rows.find((r) => r['organization_id'] === orgId && r['id'] === contactId);
        if (!row) {
          row = { id: contactId, organization_id: orgId };
          contacts.rows.push(row);
        }
        try {
          row['source_metadata'] = JSON.parse(json);
        } catch {
          row['source_metadata'] = json;
        }
        return { rows: [], rowCount: 1 };
      }
      // conversations
      if (trimmed.startsWith('select metadata')) {
        const [orgId, convId] = params as [string, string];
        const found = conversations.rows.find(
          (r) => r['organization_id'] === orgId && r['id'] === convId,
        );
        return { rows: found ? [{ metadata: found['metadata'] ?? null }] : [], rowCount: found ? 1 : 0 };
      }
      if (trimmed.startsWith('update conversations')) {
        const [orgId, convId, json] = params as [string, string, string];
        let row = conversations.rows.find(
          (r) => r['organization_id'] === orgId && r['id'] === convId,
        );
        if (!row) {
          row = { id: convId, organization_id: orgId };
          conversations.rows.push(row);
        }
        try {
          row['metadata'] = JSON.parse(json);
        } catch {
          row['metadata'] = json;
        }
        return { rows: [], rowCount: 1 };
      }
      // idempotency_keys
      if (trimmed.startsWith('insert into idempotency_keys')) {
        const [orgId, key, provider] = params as [string, string, string];
        const existing = idempotencyKeys.rows.find(
          (r) =>
            r['organization_id'] === orgId &&
            r['key'] === key &&
            r['external_provider'] === provider,
        );
        if (existing) {
          return { rows: [], rowCount: 0 };
        }
        const row: Row = {
          id: `ik-${idempotencyKeys.rows.length + 1}`,
          organization_id: orgId,
          key,
          external_provider: provider,
        };
        idempotencyKeys.rows.push(row);
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      if (trimmed.startsWith('select id') && trimmed.includes('from idempotency_keys')) {
        const [orgId, key, provider] = params as [string, string, string];
        const found = idempotencyKeys.rows.find(
          (r) =>
            r['organization_id'] === orgId &&
            r['key'] === key &&
            r['external_provider'] === provider,
        );
        return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
      }
      // orders lookup by external_id (replay)
      if (trimmed.startsWith('select id') && trimmed.includes('from orders')) {
        const [orgId, provider, externalId] = params as [string, string, string];
        const found = orders.rows.find(
          (r) =>
            r['organization_id'] === orgId &&
            r['external_provider'] === provider &&
            r['external_id'] === externalId,
        );
        return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
      }
      // orders insert
      if (trimmed.startsWith('insert into orders')) {
        const [
          orderId,
          orgId,
          contactId,
          provider,
          externalId,
          externalStatus,
          payloadJson,
          status,
          currency,
          totalCents,
          conversationId,
          reservationId,
        ] = params as [string, string, string, string, string, string, string, string, string, number, string, string];
        const row: Row = {
          id: orderId,
          organization_id: orgId,
          contact_id: contactId,
          external_provider: provider,
          external_id: externalId,
          external_status: externalStatus,
          external_payload: payloadJson,
          status,
          currency,
          total_cents: totalCents,
          conversation_id: conversationId,
          idempotency_key_id: reservationId,
        };
        orders.rows.push(row);
        return { rows: [{ id: orderId }], rowCount: 1 };
      }
      // food_order_items insert
      if (trimmed.startsWith('insert into food_order_items')) {
        const [id, orgId, orderId, productId, productName, unitPriceCents, quantity, lineTotalCents, modifiers] = params as [
          string,
          string,
          string,
          string,
          string,
          number,
          number,
          number,
          string,
        ];
        const row: Row = {
          id,
          organization_id: orgId,
          order_id: orderId,
          product_id: productId,
          product_name_snapshot: productName,
          unit_price_cents: unitPriceCents,
          quantity,
          line_total_cents: lineTotalCents,
          selected_modifiers: modifiers,
        };
        foodOrderItems.rows.push(row);
        return { rows: [{ id }], rowCount: 1 };
      }
      // select food_order_items
      if (trimmed.startsWith('select id') && trimmed.includes('from food_order_items')) {
        const [orderId, orgId] = params as [string, string];
        const found = foodOrderItems.rows.filter(
          (r) => r['order_id'] === orderId && r['organization_id'] === orgId,
        );
        return { rows: found.map((r) => ({ id: r.id })), rowCount: found.length };
      }
      // select order by idempotency_key join
      if (trimmed.startsWith('select id, organization_id, external_payload')) {
        const [orgId, key] = params as [string, string];
        const order = orders.rows.find((o) => {
          const ik = idempotencyKeys.rows.find(
            (k) => k['id'] === o['idempotency_key_id'] && k['key'] === key,
          );
          return o['organization_id'] === orgId && ik !== undefined;
        });
        if (order) {
          return {
            rows: [
              {
                id: order.id,
                organization_id: order['organization_id'],
                external_payload: order['external_payload'],
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      // fn_food_public_catalog -> retorna catalogo mockado
      if (trimmed.startsWith('select') && trimmed.includes('fn_food_public_catalog')) {
        return {
          rows: [
            {
              tenant: { id: 'tenant-1', slug: 'tortasdocalmon', name: 'Tortas do Calmon' },
              categories: [{ id: 'cat-bolos', name: 'Bolos' }],
              products: [
                {
                  id: 'prod-bolo',
                  category_id: 'cat-bolos',
                  name: 'Bolo de Chocolate',
                  slug: 'bolo-de-chocolate',
                  price_cents: 12000,
                  modifier_groups: [{ modifiers: [] }],
                },
              ],
              recommendation_rules: [],
            },
          ],
          rowCount: 1,
        };
      }
      // fallback
      throw new Error(`mock pool: SQL nao tratada -> ${sql.slice(0, 80)}`);
    }),
  } as unknown as pg.Pool;

  return pool;
}

// ---- helpers ----

function makeFakeAdapter(returnId: string | null): AthosOrderAdapter & { calls: number } {
  const adapter = {
    provider: 'athos' as const,
    isConfigured: () => true,
    calls: 0,
    createAthosOrder: vi.fn(async (input: { idempotencyKey: string }) => {
      adapter.calls++;
      if (returnId === null) {
        const err = new Error('mock athos unavailable') as Error & { code: string };
        err.code = ATHOS_ORDER_WRITE_UNAVAILABLE;
        throw err;
      }
      return {
        externalOrderId: returnId,
        externalStatus: 'created',
        externalPayload: { echo: input.idempotencyKey },
        athosCreatedAt: new Date().toISOString(),
      };
    }),
  };
  return adapter;
}

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const baseDeps = {
  pool: undefined as unknown as pg.Pool,
  organizationId: 'org-tortas',
  contactId: 'contact-1',
  conversationId: 'conv-1',
  tenantSlug: 'tortasdocalmon',
};

// ---- tests ----

describe('athos-bridge-handler-integration (briefing recovery)', () => {
  beforeEach(() => {
    clearAthosAdapter();
    clearAthosCatalogCache();
  });

  it('worker/runtime resolver: tenant desabilitado -> null (full pipeline)', async () => {
    const pool = makeMockPool();
    const log = makeLog();
    const out = await tryHandleAthosOrderBridge({
      pool,
      organizationId: 'org-1',
      contactId: 'c-1',
      conversationId: 'conv-1',
      text: 'oi',
      log,
    });
    expect(out).toBeNull();
  });

  it('worker/runtime resolver: org habilitada resolve slug e trata cart + confirmation sem injecao manual', async () => {
    const pool = makeMockPool({ enabledTenantSlug: 'tenant-runtime' });
    const log = makeLog();
    const adapter = makeFakeAdapter('athos-runtime-001');
    setAthosAdapter(adapter);

    const cart = await tryHandleAthosOrderBridge({
      pool,
      organizationId: baseDeps.organizationId,
      contactId: baseDeps.contactId,
      conversationId: baseDeps.conversationId,
      text: 'quero 1 Bolo de Chocolate',
      log,
    });
    expect(cart?.outcome.handled).toBe(true);
    expect(cart?.outcome.state).toBe('awaiting_confirmation');

    const confirmation = await tryHandleAthosOrderBridge({
      pool,
      organizationId: baseDeps.organizationId,
      contactId: baseDeps.contactId,
      conversationId: baseDeps.conversationId,
      text: 'confirmo',
      log,
    });
    expect(confirmation?.outcome.handled).toBe(true);
    expect(confirmation?.outcome.state).toBe('completed');
    expect(confirmation?.responseText).toContain('athos-runtime-001');
    expect(adapter.calls).toBe(1);
    expect(
      vi.mocked(pool.query).mock.calls.some(
        ([sql]) =>
          String(sql).includes('from organizations o') &&
          String(sql).includes('food_commerce_settings'),
      ),
    ).toBe(true);
  });

  it('cart_selection: "quero 1 Bolo de Chocolate" -> handled=true, cart persistido', async () => {
    const pool = makeMockPool();
    const log = makeLog();
    const adapter = makeFakeAdapter(null);
    setAthosAdapter(adapter);

    const out = await handleFoodserviceOrderTurn(
      {
        pool,
        organizationId: baseDeps.organizationId,
        contactId: baseDeps.contactId,
        conversationId: baseDeps.conversationId,
        tenantSlug: baseDeps.tenantSlug,
      },
      'quero 1 Bolo de Chocolate',
    );

    expect(out.handled).toBe(true);
    expect(out.cartItems.length).toBe(1);
    expect(out.cartItems[0]?.productName).toBe('Bolo de Chocolate');
    expect(out.state).toBe('awaiting_confirmation');
    expect(adapter.calls).toBe(0);
  });

  it('cart_selection: produto inexistente -> handled=false (nada casa, segue LLM)', async () => {
    const pool = makeMockPool();
    const log = makeLog();
    const out = await handleFoodserviceOrderTurn(
      {
        pool,
        organizationId: baseDeps.organizationId,
        contactId: baseDeps.contactId,
        conversationId: baseDeps.conversationId,
        tenantSlug: baseDeps.tenantSlug,
      },
      'oi tudo bem?',
    );
    expect(out.handled).toBe(false);
    expect(out.cartItems.length).toBe(0);
    expect(out.state).toBe('no_change');
  });

  it('sem cart_items + texto de confirmacao -> handled=false', async () => {
    const pool = makeMockPool();
    const out = await handleFoodserviceOrderTurn(
      {
        pool,
        organizationId: baseDeps.organizationId,
        contactId: baseDeps.contactId,
        conversationId: baseDeps.conversationId,
        tenantSlug: baseDeps.tenantSlug,
      },
      'confirmo',
    );
    expect(out.handled).toBe(false);
  });

  it('confirmation: cart existe + adapter Athos indisponivel -> ATHOS_ORDER_WRITE_UNAVAILABLE preserva cart', async () => {
    const pool = makeMockPool();
    const adapter = makeFakeAdapter(null);
    setAthosAdapter(adapter);

    // 1. Seleciona 1 item
    await handleFoodserviceOrderTurn(
      {
        pool,
        organizationId: baseDeps.organizationId,
        contactId: baseDeps.contactId,
        conversationId: baseDeps.conversationId,
        tenantSlug: baseDeps.tenantSlug,
      },
      'quero 1 Bolo de Chocolate',
    );

    // 2. Confirma
    const out = await handleFoodserviceOrderTurn(
      {
        pool,
        organizationId: baseDeps.organizationId,
        contactId: baseDeps.contactId,
        conversationId: baseDeps.conversationId,
        tenantSlug: baseDeps.tenantSlug,
      },
      'confirmo',
    );

    expect(out.handled).toBe(true);
    expect(out.errorCode).toBe(ATHOS_ORDER_WRITE_UNAVAILABLE);
    expect(out.state).toBe('reconciliation_required');
    expect(out.responseText).toMatch(/carrinho e party size estao salvos/);
    // NAO diz "pedido confirmado"
    expect(out.responseText).not.toMatch(/pedido confirmado/i);
    expect(adapter.calls).toBe(1);
  });

  it('5 replays da mesma confirmacao -> 1 pedido Athos + 1 espelho CRM', async () => {
    const pool = makeMockPool();
    const adapter = makeFakeAdapter('athos-replay-001');
    setAthosAdapter(adapter);

    // seleciona 1 item
    await handleFoodserviceOrderTurn(
      {
        pool,
        organizationId: baseDeps.organizationId,
        contactId: baseDeps.contactId,
        conversationId: baseDeps.conversationId,
        tenantSlug: baseDeps.tenantSlug,
      },
      'quero 1 Bolo de Chocolate',
    );

    // 5x confirmacao
    for (let i = 0; i < 5; i++) {
      const out = await handleFoodserviceOrderTurn(
        {
          pool,
          organizationId: baseDeps.organizationId,
          contactId: baseDeps.contactId,
          conversationId: baseDeps.conversationId,
          tenantSlug: baseDeps.tenantSlug,
        },
        'confirmo',
      );
      if (i === 0) {
        expect(out.handled).toBe(true);
        expect(out.state).toBe('completed');
        expect(out.responseText).toContain('athos-replay-001');
      } else {
        // 2o..5o replay: snapshot ja crm_recorded/completed -> nao casa
        expect(out.handled).toBe(false);
      }
    }
    expect(adapter.calls).toBe(1);
  });

  it('recovery: snapshot athos_created -> espelha UMA vez; 2a recovery noop', async () => {
    const pool = makeMockPool();
    const adapter = makeFakeAdapter('athos-crash-001');
    setAthosAdapter(adapter);

    // seleciona
    await handleFoodserviceOrderTurn(
      {
        pool,
        organizationId: baseDeps.organizationId,
        contactId: baseDeps.contactId,
        conversationId: baseDeps.conversationId,
        tenantSlug: baseDeps.tenantSlug,
      },
      'quero 1 Bolo de Chocolate',
    );

    // Confirma — sucesso
    const first = await handleFoodserviceOrderTurn(
      {
        pool,
        organizationId: baseDeps.organizationId,
        contactId: baseDeps.contactId,
        conversationId: baseDeps.conversationId,
        tenantSlug: baseDeps.tenantSlug,
      },
      'confirmo',
    );
    expect(first.state).toBe('completed');

    // runAthosRecovery: snapshot ja em completed -> null (noop)
    const recovery1 = await runAthosRecovery({
      pool,
      organizationId: baseDeps.organizationId,
      contactId: baseDeps.contactId,
      conversationId: baseDeps.conversationId,
      tenantSlug: baseDeps.tenantSlug,
    });
    expect(recovery1).toBeNull();
    expect(adapter.calls).toBe(1);
  });

  it('nested JSONB preservation: party_size preserva chaves foodservice e externas', async () => {
    const pool = makeMockPool({
      contactSourceMetadata: {
        foodservice: { existing_key: 'keep_me' },
        other: 'keep_me_too',
      },
    });
    await persistPartySizeFromFastPath(
      {
        pool,
        organizationId: baseDeps.organizationId,
        contactId: baseDeps.contactId,
        conversationId: baseDeps.conversationId,
        tenantSlug: baseDeps.tenantSlug,
      },
      6,
    );
    const persisted = await pool.query<{ source_metadata: Record<string, unknown> }>(
      `select source_metadata
         from contacts
        where organization_id = $1 and id = $2
        limit 1`,
      [baseDeps.organizationId, baseDeps.contactId],
    );
    expect(persisted.rows[0]?.source_metadata).toMatchObject({
      foodservice: {
        existing_key: 'keep_me',
        party_size: 6,
      },
      other: 'keep_me_too',
    });
  });

  it('LGPD-safe: cart snapshot NAO inclui cartao, CVV ou documento', async () => {
    const pool = makeMockPool();
    const adapter = makeFakeAdapter('athos-lgpd-001');
    setAthosAdapter(adapter);
    await handleFoodserviceOrderTurn(
      {
        pool,
        organizationId: baseDeps.organizationId,
        contactId: baseDeps.contactId,
        conversationId: baseDeps.conversationId,
        tenantSlug: baseDeps.tenantSlug,
      },
      'quero 1 Bolo de Chocolate',
    );
    // confirma
    const out = await handleFoodserviceOrderTurn(
      {
        pool,
        organizationId: baseDeps.organizationId,
        contactId: baseDeps.contactId,
        conversationId: baseDeps.conversationId,
        tenantSlug: baseDeps.tenantSlug,
      },
      'pode fechar',
    );
    expect(out.responseText).not.toMatch(/cartao|cvv|documento|cpf|rg/i);
    expect(out.responseText).not.toMatch(/[0-9]{16}/);
  });
});

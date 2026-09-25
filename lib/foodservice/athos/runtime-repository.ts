/**
 * Repository real para o bridge Athos x Sarah (briefing recovery
 * Athos x Sarah E2E 2026-09-13).
 *
 * SEM ORM, SEM mock de interface: usa SQL direto via pg.Pool. As queries
 * aqui sao o caminho REAL que o runtime percorre para persistir:
 *   - party_size em contacts.source_metadata (jsonb merge, nao destrutivo)
 *   - cart/confirmation em conversations.metadata (jsonb merge)
 *   - pedido em orders (com idempotency_keys para replay-safe)
 *   - itens em food_order_items (via orders.id resolvido pelo idempotency)
 *
 * LGPD: o snapshot do cart NAO persiste cartao, CVV ou documento -
 * apenas party_size, itens, datas e identificadores de idempotencia.
 */

import type pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import type { AthosCartItem, AthosOrderSnapshot } from './order-state';
import { emptyAthosOrderSnapshot } from './order-state';
import type { AthosOrderWriteResult } from './order-adapter';
import type { OrderMirrorClient, OrderMirrorResult } from './order-mirror';
import { fetchAthosCatalog, type AthosCatalog } from './athos-catalog';

/**
 * Resolve o slug no banco para a organizacao do turno. A configuracao e
 * deliberadamente tenant-agnostic: somente food commerce habilitado liga o
 * bridge, e desabilitar a linha passa a valer no turno seguinte.
 */
export async function resolveEnabledAthosTenantSlug(
  pool: pg.Pool,
  organizationId: string,
): Promise<string | null> {
  const result = await pool.query<{ tenant_slug: string }>(
    `select o.slug::text as tenant_slug
       from organizations o
       join food_commerce_settings f on f.organization_id = o.id
      where o.id = $1
        and f.is_enabled = true
        and nullif(trim(o.slug::text), '') is not null
      limit 1`,
    [organizationId],
  );
  const slug = result.rows[0]?.tenant_slug?.trim();
  return slug === undefined || slug === '' ? null : slug;
}

export async function readContactSourceMetadata(
  pool: pg.Pool,
  organizationId: string,
  contactId: string,
): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{ source_metadata: Record<string, unknown> | null }>(
    `select source_metadata
       from contacts
      where organization_id = $1 and id = $2
      limit 1`,
    [organizationId, contactId],
  );
  return result.rows[0]?.source_metadata ?? null;
}

export async function writeContactSourceMetadata(
  pool: pg.Pool,
  organizationId: string,
  contactId: string,
  next: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `update contacts
        set source_metadata = $3::jsonb,
            updated_at = now()
      where organization_id = $1 and id = $2`,
    [organizationId, contactId, JSON.stringify(next)],
  );
}

export async function readConversationMetadata(
  pool: pg.Pool,
  organizationId: string,
  conversationId: string,
): Promise<Record<string, unknown> | null> {
  const result = await pool.query<{ metadata: Record<string, unknown> | null }>(
    `select metadata
       from conversations
      where organization_id = $1 and id = $2
      limit 1`,
    [organizationId, conversationId],
  );
  return result.rows[0]?.metadata ?? null;
}

export async function writeConversationMetadata(
  pool: pg.Pool,
  organizationId: string,
  conversationId: string,
  next: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `update conversations
        set metadata = $3::jsonb,
            updated_at = now()
      where organization_id = $1 and id = $2`,
    [organizationId, conversationId, JSON.stringify(next)],
  );
}

/**
 * Tenta reservar a idempotency_key para um pedido Athos. Se a chave ja
 * existe, retorna `wasReplay=true` e o `crmOrderId` gravado na reserva
 * anterior - garantindo que 5 replays da mesma confirmacao resultem em
 * 1 espelho CRM.
 */
export async function reserveAthosIdempotencyKey(
  pool: pg.Pool,
  organizationId: string,
  idempotencyKey: string,
  externalProvider: 'athos',
): Promise<{ reservationId: string; wasReplay: boolean }> {
  const client = await pool.connect();
  const endpoint = `athos_order:${externalProvider}`;
  try {
    await client.query('begin');
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${organizationId}:${endpoint}:${idempotencyKey}`],
    );
    const lookup = await client.query<{ id: string }>(
      `select id from idempotency_keys
        where organization_id = $1 and key = $2 and endpoint = $3 and expires_at > now()
        order by created_at desc limit 1`,
      [organizationId, idempotencyKey, endpoint],
    );
    if (lookup.rows[0]) {
      await client.query('commit');
      return { reservationId: lookup.rows[0].id, wasReplay: true };
    }
    const hash = createHash('sha256').update(`${organizationId}:${endpoint}:${idempotencyKey}`).digest();
    const insert = await client.query<{ id: string }>(
      `insert into idempotency_keys
         (organization_id, key, endpoint, request_hash, status_code, response_body, expires_at)
       values ($1, $2, $3, $4, 202, '{}'::jsonb, now() + interval '24 hours')
       returning id`,
      [organizationId, idempotencyKey, endpoint, hash],
    );
    await client.query('commit');
    return { reservationId: insert.rows[0]?.id ?? '', wasReplay: false };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function makePgOrderMirrorClient(pool: pg.Pool): OrderMirrorClient {
  return {
    async insertOrderWithIdempotency(input) {
      const reservation = await reserveAthosIdempotencyKey(
        pool,
        input.organizationId,
        input.idempotencyKey,
        'athos',
      );
      if (reservation.wasReplay) {
        const existing = await pool.query<{ id: string }>(
          `select id
             from orders
            where organization_id = $1
              and external_provider = $2
              and external_id = $3
            limit 1`,
          [input.organizationId, input.externalProvider, input.externalId],
        );
        if (existing.rows[0]) return { orderId: existing.rows[0].id, wasReplay: true };
      }
      const totalCents = Math.max(0, input.totalCents);
      const orderId = randomUUID();
      const payload = {
        source: 'athos',
        athos_status: input.externalStatus,
        athos_payload: input.externalPayload,
        athos_idempotency_key: input.idempotencyKey,
        conversation_id: input.conversationId,
      };
      const insert = await pool.query<{ id: string }>(
        `insert into orders
           (id, organization_id, contact_id, external_provider, external_id,
            customer_external_id, status, currency, total_cents, payload, ordered_at,
            updated_at_remote, created_at, updated_at)
         values ($1, $2, $3, $4, $5, null, 'pending', $6, $7, $8::jsonb,
                 now(), now(), now(), now())
         on conflict (organization_id, external_provider, external_id) do nothing
         returning id`,
        [
          orderId,
          input.organizationId,
          input.contactId,
          input.externalProvider,
          input.externalId,
          input.currency,
          totalCents,
          JSON.stringify(payload),
        ],
      );
      if (insert.rows[0]) return { orderId: insert.rows[0].id, wasReplay: false };
      const existing = await pool.query<{ id: string }>(
        `select id from orders
          where organization_id = $1 and external_provider = $2 and external_id = $3 limit 1`,
        [input.organizationId, input.externalProvider, input.externalId],
      );
      return { orderId: existing.rows[0]?.id ?? '', wasReplay: true };
    },
    async insertFoodOrderItems(input) {
      if (input.items.length === 0) return [] as string[];
      const existing = await pool.query<{ id: string }>(
        `select id from food_order_items where organization_id = $1 and order_id = $2`,
        [input.organizationId, input.orderId],
      );
      if (existing.rows.length > 0) return existing.rows.map((row) => row.id);
      const ids: string[] = [];
      for (const item of input.items) {
        const id = randomUUID();
        const modifiersDelta = item.modifiers.reduce((sum, modifier) => sum + modifier.priceDeltaCents, 0);
        const lineTotalCents = (item.unitPriceCents + modifiersDelta) * item.quantity;
        await pool.query(
          `insert into food_order_items
             (id, organization_id, order_id, product_id, external_product_id, external_sku,
              product_name_snapshot, unit_price_cents, quantity,
              line_total_cents, selected_modifiers, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                   $10, $11::jsonb, now())`,
          [
            id,
            input.organizationId,
            input.orderId,
            item.productId ?? item.externalProductId,
            item.externalProductId,
            item.sku ?? null,
            item.productName,
            item.unitPriceCents,
            item.quantity,
            lineTotalCents,
            JSON.stringify(item.modifiers),
          ],
        );
        ids.push(id);
      }
      return ids;
    },
  };
}

/**
 * Snapshot persistido em conversations.metadata.athos_order.
 * NAO inclui dados sensiveis (cartao, CVV, documento).
 */
export const ATHOS_METADATA_KEY = 'athos_order';
export const PARTY_SIZE_METADATA_KEY = 'foodservice';

export async function loadAthosSnapshotFromMetadata(deps: {
  pool: pg.Pool;
  organizationId: string;
  conversationId: string;
}): Promise<AthosOrderSnapshot> {
  const metadata = await readConversationMetadata(
    deps.pool,
    deps.organizationId,
    deps.conversationId,
  );
  if (metadata === null) return emptyAthosOrderSnapshot();
  const value = metadata[ATHOS_METADATA_KEY];
  if (value === null || value === undefined || typeof value !== 'object') {
    return emptyAthosOrderSnapshot();
  }
  return value as AthosOrderSnapshot;
}

export async function persistAthosSnapshot(
  deps: {
    pool: pg.Pool;
    organizationId: string;
    conversationId: string;
  },
  snapshot: AthosOrderSnapshot,
): Promise<AthosOrderSnapshot> {
  const current = await readConversationMetadata(
    deps.pool,
    deps.organizationId,
    deps.conversationId,
  );
  const next = { ...(current ?? {}), [ATHOS_METADATA_KEY]: snapshot };
  await writeConversationMetadata(
    deps.pool,
    deps.organizationId,
    deps.conversationId,
    next,
  );
  return snapshot;
}

export async function persistPartySize(
  deps: {
    pool: pg.Pool;
    organizationId: string;
    contactId: string;
  },
  partySize: number,
): Promise<void> {
  const current = await readContactSourceMetadata(
    deps.pool,
    deps.organizationId,
    deps.contactId,
  );
  const next = buildPartySizeMetadata(current, partySize);
  await writeContactSourceMetadata(
    deps.pool,
    deps.organizationId,
    deps.contactId,
    next,
  );
}

export function computeIdempotencyKeyFromConversation(deps: {
  organizationId: string;
  conversationId: string;
}): string {
  return createHash('sha256')
    .update(`${deps.organizationId}|${deps.conversationId}`)
    .digest('hex')
    .slice(0, 32);
}

export async function readAthosCatalogForTenant(deps: {
  pool: pg.Pool;
  organizationId: string;
  tenantSlug: string;
}): Promise<AthosCatalog> {
  return await fetchAthosCatalog(deps.pool, deps.organizationId, deps.tenantSlug);
}

export function buildAthosOrderMetadata(snapshot: AthosOrderSnapshot): Record<string, unknown> {
  return { [ATHOS_METADATA_KEY]: snapshot };
}

export function buildPartySizeMetadata(
  current: Record<string, unknown> | null,
  partySize: number,
): Record<string, unknown> {
  const foodservice = (current?.['foodservice'] as Record<string, unknown> | undefined) ?? {};
  return {
    ...(current ?? {}),
    foodservice: {
      ...foodservice,
      party_size: partySize,
      updated_at: new Date().toISOString(),
    },
  };
}

export function buildCartMetadataPatch(
  snapshot: AthosOrderSnapshot,
  cartItems: ReadonlyArray<AthosCartItem>,
  partySize: number,
  idempotencyKey: string,
  confirmationToken: string,
): AthosOrderSnapshot {
  return {
    ...snapshot,
    cartItems,
    partySize,
    confirmationToken,
    updatedAt: new Date().toISOString(),
  };
}

export async function loadOrderMirrorResultByIdempotencyKey(
  pool: pg.Pool,
  organizationId: string,
  idempotencyKey: string,
): Promise<OrderMirrorResult | null> {
  const order = await pool.query<{
    id: string;
    organization_id: string;
    payload: Record<string, unknown> | null;
  }>(
    `select id, organization_id, payload
       from orders
      where organization_id = $1
        and external_provider = 'athos'
        and payload->>'athos_idempotency_key' = $2
      limit 1`,
    [organizationId, idempotencyKey],
  );
  const orderRow = order.rows[0];
  if (orderRow === undefined) return null;
  const items = await pool.query<{ id: string }>(
    `select id from food_order_items where order_id = $1 and organization_id = $2`,
    [orderRow.id, organizationId],
  );
  return {
    crmOrderId: orderRow.id,
    foodOrderItemIds: items.rows.map((r) => r.id),
    wasReplay: true,
  };
}

export function externalOrderIdFromSnapshot(snapshot: AthosOrderSnapshot): string | null {
  return snapshot.externalOrderId;
}

export function buildAthosOrderWriteResult(
  externalOrderId: string,
): AthosOrderWriteResult {
  return {
    externalOrderId,
    externalStatus: 'created',
    externalPayload: {},
    athosCreatedAt: new Date().toISOString(),
  };
}

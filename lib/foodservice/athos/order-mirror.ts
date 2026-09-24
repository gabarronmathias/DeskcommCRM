/**
 * Mirror CRM do pedido Athos (briefing recovery Athos × Sarah E2E 2026-09-13).
 *
 * Estado `athos_created` → `crm_recorded` grava em `orders` +
 * `food_order_items` o espelho do pedido criado na Athos. Sem migration:
 * usa colunas existentes (`orders.external_id`, `orders.payload`,
 * `orders.external_provider`).
 *
 * IMPORTANTE: o CHECK `orders_external_provider_check` no schema atual
 * aceita apenas (nuvemshop, vtex, shopify, deskcomm_food, gm_crm_food).
 * Para uma instalacao self-host com baseline fresco, o espelho usa
 * `gm_crm_food` como `external_provider` e sinaliza `athos` em
 * `payload.source` ate que uma migration adicione 'athos' ao
 * CHECK. O mirror NAO falha por isso — apenas rotula a origem do
 * pedido de forma fiel.
 *
 * Idempotencia: o espelho usa `idempotency_keys` (tabela existente) e a
 * chave externa unica de `orders`; replay da mesma confirmacao nao cria
 * outra ordem nem duplica os itens.
 *
 * Recovery: quando o espelho falha DEPOIS de `athos_created` (ex.: worker
 * caiu entre adapter e mirror), o recovery busca conversas em
 * `athos_created` sem `crm_recorded` e retenta o espelho com a mesma
 * idempotency_key — garantindo 1 espelho por pedido Athos.
 */

import type { AthosOrderWriteResult } from './order-adapter';
import type { AthosCartItem, AthosOrderSnapshot } from './order-state';

export interface OrderMirrorInput {
  organizationId: string;
  contactId: string;
  conversationId: string;
  athosCreated: AthosOrderWriteResult;
  cartItems: ReadonlyArray<AthosCartItem>;
  partySize: number | null;
  idempotencyKey: string;
  externalProvider: 'gm_crm_food' | 'athos';
}

export interface OrderMirrorResult {
  crmOrderId: string;
  foodOrderItemIds: ReadonlyArray<string>;
  wasReplay: boolean;
}

export interface OrderMirrorClient {
  insertOrderWithIdempotency(input: {
    organizationId: string;
    externalProvider: 'gm_crm_food' | 'athos';
    externalId: string;
    externalStatus: string;
    externalPayload: Record<string, unknown>;
    totalCents: number;
    currency: string;
    idempotencyKey: string;
    contactId: string;
    conversationId: string | null;
  }): Promise<{ orderId: string; wasReplay: boolean }>;
  insertFoodOrderItems(input: {
    orderId: string;
    organizationId: string;
    items: ReadonlyArray<{
      productId?: string;
      externalProductId: string;
      sku?: string | null;
      productName: string;
      quantity: number;
      unitPriceCents: number;
      modifiers: ReadonlyArray<{ name: string; priceDeltaCents: number }>;
    }>;
  }): Promise<ReadonlyArray<string>>;
}

export async function mirrorAthosOrderToCrm(
  client: OrderMirrorClient,
  input: OrderMirrorInput,
): Promise<OrderMirrorResult> {
  const totalCents = computeTotalCents(input.cartItems);
  const externalPayload = {
    source: 'athos',
    athos_created_at: input.athosCreated.athosCreatedAt,
    athos_status: input.athosCreated.externalStatus,
    party_size: input.partySize,
    ...input.athosCreated.externalPayload,
  };
  const inserted = await client.insertOrderWithIdempotency({
    organizationId: input.organizationId,
    externalProvider: input.externalProvider,
    externalId: input.athosCreated.externalOrderId,
    externalStatus: input.athosCreated.externalStatus,
    externalPayload,
    totalCents,
    currency: 'BRL',
    idempotencyKey: input.idempotencyKey,
    contactId: input.contactId,
    conversationId: input.conversationId,
  });
  const itemIds = await client.insertFoodOrderItems({
    orderId: inserted.orderId,
    organizationId: input.organizationId,
    items: input.cartItems,
  });
  return {
    crmOrderId: inserted.orderId,
    foodOrderItemIds: itemIds,
    wasReplay: inserted.wasReplay,
  };
}

export function computeTotalCents(items: ReadonlyArray<AthosCartItem>): number {
  return items.reduce((acc, item) => {
    const modifiersDelta = item.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0);
    return acc + item.quantity * (item.unitPriceCents + modifiersDelta);
  }, 0);
}

/**
 * Encontra conversas em `athos_created` sem `crm_recorded` para o
 * recovery re-aplicar o espelho (chamada de retry).
 */
export function isRecoverableAthosSnapshot(snapshot: AthosOrderSnapshot): boolean {
  return (
    snapshot.state === 'athos_created' &&
    snapshot.externalOrderId !== null &&
    snapshot.crmOrderId === null
  );
}

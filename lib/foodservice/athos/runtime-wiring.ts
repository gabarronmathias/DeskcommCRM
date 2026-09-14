/**
 * Orquestrador runtime do bridge Athos x Sarah (briefing recovery
 * Athos x Sarah E2E 2026-09-13).
 *
 * Conecta os modulos puros (order-state, order-adapter, order-mirror,
 * confirmation, cart-store, recovery) ao caminho REAL do runtime:
 *   - le catalogs do Supabase
 *   - escreve em contacts.source_metadata + conversations.metadata
 *   - chama order adapter (boundary explicito quando API Athos nao existe)
 *   - espelha em orders + food_order_items
 *   - recupera apos crash antes do espelho
 *
 * SEM WORKAROUND: quando createAthosOrder falha com
 * ATHOS_ORDER_WRITE_UNAVAILABLE, a Sarah NAO diz "pedido confirmado" -
 * preserva o cart + estado para retry futuro e devolve uma mensagem
 * transparente ao cliente.
 */

import type pg from 'pg';
import { randomUUID } from 'node:crypto';

import type {
  AthosCatalog,
} from './athos-catalog';
import { fetchAthosCatalog } from './athos-catalog';
import {
  createAthosOrder,
  type AthosOrderWriteInput,
} from './order-adapter';
import {
  emptyAthosOrderSnapshot,
  transitionAthosOrder,
  type AthosCartItem,
  type AthosOrderSnapshot,
} from './order-state';
import {
  confirmAthosOrder,
  createConfirmationToken,
  ATHOS_CONFIRMATION_ALREADY_CONSUMED,
} from './confirmation';
import { detectAndResolveCartSelection } from './cart-selection';
import { detectExplicitConfirmation } from './confirmation-detector';
import {
  buildAthosOrderMetadata,
  buildPartySizeMetadata,
  computeIdempotencyKeyFromConversation,
  loadAthosSnapshotFromMetadata,
  makePgOrderMirrorClient,
  persistAthosSnapshot,
  persistPartySize,
  readAthosCatalogForTenant,
} from './runtime-repository';
import {
  mirrorAthosOrderToCrm,
  type OrderMirrorResult,
} from './order-mirror';
import { buildRecoveryOutcome } from './recovery';

export interface RuntimeWiringDeps {
  pool: pg.Pool;
  organizationId: string;
  contactId: string;
  conversationId: string;
  tenantSlug: string;
  contactName?: string | null;
}

export interface RuntimeWiringOutcome {
  handled: boolean;
  responseText: string;
  partySize: number | null;
  cartItems: ReadonlyArray<AthosCartItem>;
  state: import('./order-state').AthosOrderState | 'no_change';
  errorCode: string | null;
}

export async function handleFoodserviceOrderTurn(
  deps: RuntimeWiringDeps,
  inboundText: string,
): Promise<RuntimeWiringOutcome> {
  const catalog = await readAthosCatalogForTenant(deps);

  const previousSnapshot = await loadAthosSnapshotFromMetadata(deps);
  const confirmationMatch = detectExplicitConfirmation(inboundText);

  if (confirmationMatch && previousSnapshot.cartItems.length > 0) {
    return handleConfirmation(deps, previousSnapshot, inboundText, catalog);
  }

  const cartSelection = detectAndResolveCartSelection(inboundText, catalog);
  if (cartSelection.matched) {
    return handleCartSelection(deps, previousSnapshot, cartSelection);
  }

  return {
    handled: false,
    responseText: '',
    partySize: previousSnapshot.partySize,
    cartItems: previousSnapshot.cartItems,
    state: 'no_change',
    errorCode: null,
  };
}

async function handleConfirmation(
  deps: RuntimeWiringDeps,
  previousSnapshot: AthosOrderSnapshot,
  inboundText: string,
  catalog: AthosCatalog,
): Promise<RuntimeWiringOutcome> {
  if (previousSnapshot.state !== 'awaiting_confirmation') {
    if (previousSnapshot.state === 'crm_recorded' || previousSnapshot.state === 'completed') {
      return {
        handled: false,
        responseText: '',
        partySize: previousSnapshot.partySize,
        cartItems: previousSnapshot.cartItems,
        state: previousSnapshot.state,
        errorCode: null,
      };
    }
    return {
      handled: false,
      responseText: '',
      partySize: previousSnapshot.partySize,
      cartItems: previousSnapshot.cartItems,
      state: previousSnapshot.state,
      errorCode: ATHOS_CONFIRMATION_ALREADY_CONSUMED,
    };
  }

  const confirmation = confirmAthosOrder(previousSnapshot, previousSnapshot.confirmationToken, previousSnapshot.partySize);
  let next = confirmation.snapshot;

  const idempotencyKey = computeIdempotencyKeyFromConversation(deps);
  const orderInput: AthosOrderWriteInput = {
    organizationId: deps.organizationId,
    contactId: deps.contactId,
    partySize: next.partySize,
    cartItems: next.cartItems,
    idempotencyKey,
    confirmationToken: confirmation.consumedToken,
    totalCents: computeTotalCents(next.cartItems),
  };

  try {
    const athosCreated = await createAthosOrder(orderInput);
    next = transitionAthosOrder(next, 'athos_created', {
      externalOrderId: athosCreated.externalOrderId,
    });
    next = await persistAthosSnapshot(deps, next);

    const mirror = await mirrorAthosOrderToCrm(
      makePgOrderMirrorClient(deps.pool),
      {
        organizationId: deps.organizationId,
        contactId: deps.contactId,
        conversationId: deps.conversationId,
        athosCreated,
        cartItems: next.cartItems,
        partySize: next.partySize,
        idempotencyKey,
        externalProvider: 'athos',
      },
    );
    next = transitionAthosOrder(next, 'crm_recorded', {
      crmOrderId: mirror.crmOrderId,
    });
    next = await persistAthosSnapshot(deps, next);

    next = transitionAthosOrder(next, 'completed');
    next = await persistAthosSnapshot(deps, next);

    return {
      handled: true,
      responseText: `Pedido criado na Athos. ID: ${athosCreated.externalOrderId}. Total: R$ ${(orderInput.totalCents / 100).toFixed(2)}.`,
      partySize: next.partySize,
      cartItems: next.cartItems,
      state: next.state,
      errorCode: null,
    };
  } catch (err) {
    const code = (err as { code: string }).code ?? 'athos_order_write_failed';
    next = transitionAthosOrder(next, 'reconciliation_required', {
      lastError: code,
      attempts: next.attempts + 1,
    });
    next = await persistAthosSnapshot(deps, next);
    const tenantName = catalog.tenantDisplayName;
    return {
      handled: true,
      responseText:
        code === 'athos_order_write_unavailable'
          ? `${tenantName}: a Athos ainda nao autorizou a escrita de pedido por aqui. Seu carrinho e party size estao salvos; eu retento assim que a integracao for liberada.`
          : `${tenantName}: nao consegui fechar o pedido na Athos (${code}). Seu carrinho esta salvo; tenta de novo daqui a pouco.`,
      partySize: next.partySize,
      cartItems: next.cartItems,
      state: next.state,
      errorCode: code,
    };
  }
}

async function handleCartSelection(
  deps: RuntimeWiringDeps,
  previousSnapshot: AthosOrderSnapshot,
  selection: { items: ReadonlyArray<AthosCartItem>; unresolvedNames: ReadonlyArray<string> },
): Promise<RuntimeWiringOutcome> {
  const merged = mergeCart(previousSnapshot.cartItems, selection.items);
  const partySize = previousSnapshot.partySize;
  let next: AthosOrderSnapshot = {
    ...previousSnapshot,
    cartItems: merged,
    state: previousSnapshot.state === 'completed' || previousSnapshot.state === 'crm_recorded'
      ? previousSnapshot.state
      : 'awaiting_confirmation',
    confirmationToken: previousSnapshot.confirmationToken === ''
      ? createConfirmationToken()
      : previousSnapshot.confirmationToken,
    attempts: previousSnapshot.attempts,
    updatedAt: new Date().toISOString(),
  };
  next = await persistAthosSnapshot(deps, next);

  const total = computeTotalCents(next.cartItems);
  const summaryLines = next.cartItems.map((i) =>
    `- ${i.quantity}x ${i.productName} (R$ ${((i.unitPriceCents * i.quantity) / 100).toFixed(2)})`,
  );
  const unresolvedText = selection.unresolvedNames.length > 0
    ? `\n\nNao encontrei no cardapio: ${selection.unresolvedNames.join(', ')}.`
    : '';
  const responseText = partySize === null
    ? `Voce selecionou ${merged.length} item(ns). Total parcial: R$ ${(total / 100).toFixed(2)}.${unresolvedText}\n\nPara quantas pessoas sera?`
    : `Voce selecionou ${merged.length} item(ns) para ${partySize} pessoas. Total: R$ ${(total / 100).toFixed(2)}.\n\n${summaryLines.join('\n')}${unresolvedText}\n\nConfirma o pedido? Responde "confirmo" ou "pode fechar" para enviar a Athos.`;

  return {
    handled: true,
    responseText,
    partySize,
    cartItems: merged,
    state: next.state,
    errorCode: null,
  };
}

export async function persistPartySizeFromFastPath(
  deps: RuntimeWiringDeps,
  partySize: number,
): Promise<void> {
  await persistPartySize(deps, partySize);
}

export async function runAthosRecovery(deps: RuntimeWiringDeps): Promise<OrderMirrorResult | null> {
  const snapshot = await loadAthosSnapshotFromMetadata(deps);
  if (
    snapshot.state !== 'athos_created' ||
    snapshot.externalOrderId === null
  ) {
    return null;
  }
  return await buildRecoveryOutcome(
    snapshot,
    {
      organizationId: deps.organizationId,
      contactId: deps.contactId,
      conversationId: deps.conversationId,
      cartItems: snapshot.cartItems,
      partySize: snapshot.partySize,
      idempotencyKey: computeIdempotencyKeyFromConversation(deps),
      athosCreated: {
        externalOrderId: snapshot.externalOrderId,
        externalStatus: 'created',
        externalPayload: {},
        athosCreatedAt: snapshot.updatedAt,
      },
      externalProvider: 'athos',
    },
    makePgOrderMirrorClient(deps.pool),
  ).then((outcome) => (outcome.mirror ?? null));
}

function computeTotalCents(items: ReadonlyArray<AthosCartItem>): number {
  return items.reduce((acc, item) => {
    const modifiersDelta = item.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0);
    return acc + item.quantity * (item.unitPriceCents + modifiersDelta);
  }, 0);
}

function mergeCart(
  current: ReadonlyArray<AthosCartItem>,
  incoming: ReadonlyArray<AthosCartItem>,
): ReadonlyArray<AthosCartItem> {
  const map = new Map<string, AthosCartItem>();
  for (const item of current) {
    map.set(item.externalProductId, item);
  }
  for (const item of incoming) {
    const existing = map.get(item.externalProductId);
    if (existing === undefined) {
      map.set(item.externalProductId, item);
    } else {
      map.set(item.externalProductId, {
        ...existing,
        quantity: existing.quantity + item.quantity,
      });
    }
  }
  return Array.from(map.values());
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

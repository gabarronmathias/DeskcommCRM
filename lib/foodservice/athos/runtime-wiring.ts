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
import { extractPartySize } from '../../agent-engine/agent/foodservice-sales-fast-path';
import {
  buildAthosOrderMetadata,
  buildPartySizeMetadata,
  computeIdempotencyKeyFromConversation,
  loadAthosSnapshotFromMetadata,
  makePgOrderMirrorClient,
  persistAthosSnapshot,
  persistPartySize,
  readAthosCatalogForTenant,
  readAthosMenuUrl,
  readOrganizationTimezone,
  startNewAthosOrderSnapshot,
} from './runtime-repository';
import { parsePickupSchedule, type PickupScheduleResult } from './pickup-schedule';
import {
  isRecoverableAthosSnapshot,
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
  now?: Date;
  recentMessages?: ReadonlyArray<{ direction: 'inbound' | 'outbound'; body: string }>;
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
  const previousSnapshot = await loadAthosSnapshotFromMetadata(deps);
  const confirmationMatch = detectExplicitConfirmation(inboundText);

  // A Athos pode ter criado o pedido antes de uma falha no espelho CRM.
  // Nesse caso nunca se chama o adapter de novo: repara-se apenas o espelho,
  // usando o mesmo externalOrderId/idempotencyKey.
  if (isRecoverableAthosSnapshot(previousSnapshot)) {
    try {
      const mirror = await runAthosRecovery(deps);
      if (mirror !== null) {
        return {
          handled: true,
          responseText: `Pedido criado na Athos. ID: ${previousSnapshot.externalOrderId}. Total: R$ ${(computeTotalCents(previousSnapshot.cartItems) / 100).toFixed(2)}.`,
          partySize: previousSnapshot.partySize,
          cartItems: previousSnapshot.cartItems,
          state: 'completed',
          errorCode: null,
        };
      }
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'athos_mirror_recovery_failed';
      return {
        handled: true,
        responseText: 'O pedido foi recebido pela Athos, mas ainda estou conferindo o registro no CRM. Não faça outro pedido enquanto verificamos.',
        partySize: previousSnapshot.partySize,
        cartItems: previousSnapshot.cartItems,
        state: previousSnapshot.state,
        errorCode: code,
      };
    }
  }

  if (EXPLICIT_NEW_ORDER_SIGNAL_RE.test(inboundText)) {
    if (previousSnapshot.state === 'submitting_to_athos' ||
        previousSnapshot.state === 'reconciliation_required') {
      return {
        handled: true,
        responseText: 'Preciso conferir o registro do pedido anterior antes de abrir outro, para não duplicar nem perder seu pedido.',
        partySize: previousSnapshot.partySize,
        cartItems: previousSnapshot.cartItems,
        state: previousSnapshot.state,
        errorCode: null,
      };
    }
    const nextSnapshot = emptyAthosOrderSnapshot();
    await startNewAthosOrderSnapshot(deps, previousSnapshot, nextSnapshot);
    return {
      handled: true,
      responseText: 'Claro — vamos abrir um pedido separado, sem alterar o anterior. Para qual ocasião você está escolhendo?',
      partySize: null,
      cartItems: [],
      state: nextSnapshot.state,
      errorCode: null,
    };
  }

  const addQuantityMatch = inboundText.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .match(/^(?:sim[, ]+)?(?:adicione|adiciona|inclua|coloque|quero)\s+(\d{1,3}|um|uma|dois|duas)\s*[.!]?$/);
  if (addQuantityMatch !== null) {
    const catalog = await readAthosCatalogForTenant(deps);
    const previousReply = deps.recentMessages?.[0]?.direction === 'outbound'
      ? deps.recentMessages[0].body : '';
    const mentioned = catalog.products.filter((product) => product.athosProductId !== null &&
      previousReply.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
        .includes(product.name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()));
    if (mentioned.length !== 1) {
      return {
        handled: true,
        responseText: 'Para não adicionar o produto errado, qual item do cardápio você quer e quantas unidades?',
        partySize: previousSnapshot.partySize,
        cartItems: previousSnapshot.cartItems,
        state: previousSnapshot.state,
        errorCode: null,
      };
    }
    const selection = detectAndResolveCartSelection(
      `${addQuantityMatch[1]} ${mentioned[0]!.name}`, catalog);
    if (!selection.matched || selection.unresolvedNames.length > 0) {
      return { handled: true,
        responseText: 'Não consegui identificar com segurança o item. Informe o nome do produto e a quantidade.',
        partySize: previousSnapshot.partySize, cartItems: previousSnapshot.cartItems,
        state: previousSnapshot.state, errorCode: null };
    }
    // "Adicione 2" is the answer to a proposed quantity, not two extra units.
    return handleCartSelection(deps, previousSnapshot, selection, `${addQuantityMatch[1]} ${mentioned[0]!.name}`, { kind: 'none' });
  }

  if (/\b(?:quanto|pre[cç]o|valor|total|custa|custar)\b/i.test(inboundText)) {
    const total = computeTotalCents(previousSnapshot.cartItems);
    return {
      handled: true,
      responseText: previousSnapshot.cartItems.length === 0
        ? 'Não há itens registrados no pedido atual; não posso calcular um total ainda. Qual produto e quantidade você deseja?'
        : `O pedido atual tem ${previousSnapshot.cartItems.map((item) => `${item.quantity}x ${item.productName}`).join(', ')}. Total: R$ ${(total / 100).toFixed(2)}. ${previousSnapshot.state === 'completed' ? 'Esse pedido já foi registrado.' : 'Ele ainda não foi confirmado.'}`,
      partySize: previousSnapshot.partySize,
      cartItems: previousSnapshot.cartItems,
      state: previousSnapshot.state,
      errorCode: null,
    };
  }

  if (confirmationMatch && previousSnapshot.cartItems.length === 0 &&
      previousSnapshot.state !== 'completed' && previousSnapshot.state !== 'crm_recorded') {
    return {
      handled: true,
      responseText: 'Ainda não há itens registrados neste pedido. Informe o produto e a quantidade antes de confirmar.',
      partySize: previousSnapshot.partySize,
      cartItems: [],
      state: previousSnapshot.state,
      errorCode: null,
    };
  }

  // Saudações e conversa geral não precisam carregar o cardápio. Mantém o
  // GPT responsável pelo atendimento normal e reserva este bridge para turnos
  // que realmente podem alterar um pedido.
  if (
    previousSnapshot.cartItems.length === 0 &&
    !confirmationMatch &&
    !ORDER_OR_MENU_SIGNAL_RE.test(inboundText)
  ) {
    return {
      handled: false,
      responseText: '',
      partySize: previousSnapshot.partySize,
      cartItems: previousSnapshot.cartItems,
      state: 'no_change',
      errorCode: null,
    };
  }

  // Cardápio vem de configuração verificável, nunca do modelo.
  if (/\b(?:card[aá]pio|menu)\b/i.test(inboundText) &&
      !/\b(?:\d{1,3}|um|uma|dois|duas)\s+(?:torta|bolo|doce|salgado)/i.test(inboundText)) {
    const menuUrl = await readAthosMenuUrl(deps.pool, deps.organizationId);
    return {
      handled: true,
      responseText: menuUrl === null
        ? 'Não consegui consultar o cardápio agora. Tente novamente em alguns instantes.'
        : `Aqui está o cardápio: ${menuUrl}`,
      partySize: previousSnapshot.partySize,
      cartItems: previousSnapshot.cartItems,
      state: previousSnapshot.state,
      errorCode: menuUrl === null ? 'athos_menu_not_configured' : null,
    };
  }

  const pickupSignal = /\bretir(?:ar|ada|o|amos|arei|a)\b|\bamanh[aã](?!\p{L})/iu.test(inboundText);
  let pickup: PickupScheduleResult = { kind: 'none' };
  if (pickupSignal || previousSnapshot.fulfillment === 'pickup') {
    const timezone = await readOrganizationTimezone(deps.pool, deps.organizationId);
    pickup = parsePickupSchedule(inboundText, deps.now ?? new Date(), timezone,
      previousSnapshot.fulfillment === 'pickup');
  }
  if (pickup.kind === 'incomplete') {
    // Um pedido como "quero 1 torta para retirada" já contém o item.
    // Preserve-o antes de pedir o horário; não obrigue o cliente a repeti-lo.
    let base = previousSnapshot;
    if (/\b(?:tortas?|bolos?|doces?|salgados?)\b/i.test(inboundText)) {
      const catalogForItem = await readAthosCatalogForTenant(deps);
      const item = detectAndResolveCartSelection(stripPickupClause(inboundText), catalogForItem);
      if (item.unresolvedNames.length > 0) {
        return { handled: true,
          responseText: `Não encontrei no catálogo Athos: ${item.unresolvedNames.join(', ')}. Confira o item no cardápio.`,
          partySize: base.partySize, cartItems: base.cartItems, state: base.state,
          errorCode: 'athos_product_not_found' };
      }
      if (item.matched) {
        await handleCartSelection(deps, base, item, inboundText, { kind: 'none' });
        base = await loadAthosSnapshotFromMetadata(deps);
      }
    }
    if (base.state === 'completed' || base.state === 'crm_recorded') base = emptyAthosOrderSnapshot();
    await persistAthosSnapshot(deps, {
      ...base, fulfillment: 'pickup', updatedAt: new Date().toISOString(),
    });
    return { handled: true, responseText: pickup.message,
      partySize: base.partySize, cartItems: base.cartItems,
      state: base.state, errorCode: 'athos_pickup_schedule_incomplete' };
  }
  // A data pode chegar antes da escolha do produto.
  if (pickup.kind === 'scheduled' &&
      (previousSnapshot.cartItems.length === 0 || previousSnapshot.state === 'completed' || previousSnapshot.state === 'crm_recorded') &&
      !/\b(?:torta|bolo|doce|salgado)\b/i.test(inboundText)) {
    const base = previousSnapshot.state === 'completed' || previousSnapshot.state === 'crm_recorded'
      ? emptyAthosOrderSnapshot() : previousSnapshot;
    const next = await persistAthosSnapshot(deps, {
      ...base, fulfillment: 'pickup',
      pickupAtLocal: pickup.value.scheduledAtLocal, pickupTimezone: pickup.value.timezone,
      updatedAt: new Date().toISOString(),
    });
    return { handled: true,
      responseText: `Anotei a retirada para ${formatPickupSchedule(next)}. Qual item você deseja?`,
      partySize: next.partySize, cartItems: next.cartItems, state: next.state, errorCode: null };
  }

  const catalog = await readAthosCatalogForTenant(deps);

  if (/\b(?:s[oó]\s+tem|tem\s+(?:outras|outros)|quais\s+(?:outras|outros))\b/i.test(inboundText) &&
      /\btortas?\b/i.test(inboundText)) {
    const tortas = catalog.products.filter((product) => product.athosProductId !== null &&
      /\btorta\b/i.test(product.name)).slice(0, 4);
    return { handled: true,
      responseText: tortas.length > 0
        ? `No cardápio de teste encontrei: ${tortas.map((product) => product.name).join(', ')}. Qual delas você gostaria de conhecer melhor?`
        : 'Não encontrei tortas verificadas no catálogo de teste agora. Quer que eu envie o link do cardápio?',
      partySize: previousSnapshot.partySize, cartItems: previousSnapshot.cartItems,
      state: previousSnapshot.state, errorCode: null };
  }

  if (/\b(?:suficiente|rende|serve|dar(?:ia)?\s+para)\b/i.test(inboundText) &&
      /\bpessoas?\b/i.test(inboundText) && /\btortas?\b/i.test(inboundText)) {
    return { handled: true,
      responseText: 'Não tenho o rendimento por torta confirmado no catálogo de teste, então não consigo garantir a quantidade para esse grupo. Você prefere 1 ou 2 unidades para eu mostrar o total exato?',
      partySize: previousSnapshot.partySize, cartItems: previousSnapshot.cartItems,
      state: previousSnapshot.state, errorCode: null };
  }

  if (confirmationMatch && previousSnapshot.cartItems.length > 0) {
    if (previousSnapshot.fulfillment === 'pickup' && !previousSnapshot.pickupAtLocal) {
      return { handled: true, responseText: 'Informe o dia e o horário da retirada antes de confirmar o pedido.',
        partySize: previousSnapshot.partySize, cartItems: previousSnapshot.cartItems,
        state: previousSnapshot.state, errorCode: 'athos_pickup_schedule_incomplete' };
    }
    return handleConfirmation(deps, previousSnapshot, inboundText, catalog);
  }

  if (pickup.kind === 'scheduled' && previousSnapshot.cartItems.length > 0 &&
      previousSnapshot.state !== 'completed' && previousSnapshot.state !== 'crm_recorded' &&
      !/\b(?:torta|bolo|doce|salgado)\b/i.test(inboundText)) {
    const next = await persistAthosSnapshot(deps, {
      ...previousSnapshot, fulfillment: 'pickup',
      pickupAtLocal: pickup.value.scheduledAtLocal, pickupTimezone: pickup.value.timezone,
      updatedAt: new Date().toISOString(),
    });
    return { handled: true,
      responseText: next.partySize === null ? 'Anotei a retirada. Para quantas pessoas será?'
        : orderConfirmationPrompt(next),
      partySize: next.partySize, cartItems: next.cartItems, state: next.state, errorCode: null };
  }

  // A resposta à pergunta "para quantas pessoas?" é dado do pedido, não
  // seleção de produto. O parser de carrinho aceita "2 pessoas" como nome de
  // item; por isso este ramo precisa vir ANTES de detectAndResolveCartSelection.
  const partySize = extractPartySize(inboundText);
  if (previousSnapshot.state === 'awaiting_confirmation' &&
      previousSnapshot.cartItems.length > 0 && partySize !== null) {
    const next = await persistAthosSnapshot(deps, {
      ...previousSnapshot,
      partySize,
      updatedAt: new Date().toISOString(),
    });
    await persistPartySize(deps, partySize);
    return {
      handled: true,
      responseText: orderConfirmationPrompt(next),
      partySize,
      cartItems: next.cartItems,
      state: next.state,
      errorCode: null,
    };
  }

  const cartSelection = detectAndResolveCartSelection(
    pickup.kind === 'scheduled' ? stripPickupClause(inboundText) : inboundText, catalog);
  if (cartSelection.unresolvedNames.length > 0) {
    return {
      handled: true,
      responseText:
        `Não consegui encontrar ou mapear no catálogo Athos: ${cartSelection.unresolvedNames.join(', ')}. ` +
        'Por isso, ainda não registrei o pedido. Confira o item no cardápio e tente novamente.',
      partySize: previousSnapshot.partySize,
      cartItems: previousSnapshot.cartItems,
      state: previousSnapshot.state,
      errorCode: 'athos_product_not_found',
    };
  }
  if (cartSelection.matched) {
    return handleCartSelection(deps, previousSnapshot, cartSelection, inboundText, pickup);
  }

  const normalizedRequest = inboundText.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (/\b(?:sugestao|sugestoes|recomendacao|recomendacoes|indicacao|indicacoes|nao sei o que (?:pedir|escolher))\b/.test(normalizedRequest)) {
    const available = catalog.products.filter((product) => product.athosProductId !== null);
    const isBeverage = (product: typeof available[number]) => {
      const category = catalog.categories.find((entry) => entry.id === product.categoryId)?.name ?? '';
      return /bebida|refrigerante|suco|[aá]gua/i.test(category) ||
        /coca-cola|guaran[aá]|refrigerante|suco|[aá]gua/i.test(product.name);
    };
    const primary = available.find((product) => !isBeverage(product)) ?? available[0];
    const alternative = primary === undefined ? undefined : available.find((product) =>
      product.id !== primary.id && product.categoryId === primary.categoryId && !isBeverage(product));
    const complement = primary === undefined ? undefined : available.find((product) =>
      product.id !== primary.id && isBeverage(product));
    const responseText = primary === undefined
      ? 'Ainda não tenho itens verificados no catálogo de teste para recomendar com segurança. Quer que eu envie o cardápio?'
      : alternative !== undefined
        ? `Uma sugestão do cardápio de teste é ${primary.name}; se quiser outra opção da mesma categoria, há ${alternative.name}. Qual combina mais com o que você procura?`
        : complement !== undefined
          ? `Uma sugestão do cardápio de teste é ${primary.name}. Para acompanhar, também há ${complement.name}. O produto principal combina com o que você procura?`
          : `Uma sugestão do cardápio de teste é ${primary.name}. Ela combina com o que você procura?`;
    return {
      handled: true,
      responseText,
      partySize: previousSnapshot.partySize,
      cartItems: previousSnapshot.cartItems,
      state: previousSnapshot.state,
      errorCode: null,
    };
  }

  if (
    previousSnapshot.cartItems.length > 0 &&
    previousSnapshot.state !== 'completed' &&
    previousSnapshot.state !== 'crm_recorded'
  ) {
    const responseText = previousSnapshot.state === 'awaiting_confirmation'
      ? previousSnapshot.partySize === null
        ? 'Seu carrinho está salvo, mas ainda não enviei o pedido. Para quantas pessoas será?'
        : orderConfirmationPrompt(previousSnapshot)
      : 'Não consegui confirmar o registro do pedido na integração. Portanto, ele ainda não está confirmado. ' +
        'O carrinho ficou salvo para conferência.';
    return {
      handled: true,
      responseText,
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
    state: 'no_change',
    errorCode: null,
  };
}

const ORDER_OR_MENU_SIGNAL_RE =
  /\b(?:card[aá]pio|menu|pedido|pedir|encomenda|comprar|quero|preciso|tortas?|bolos?|retirada|retirar|delivery|entrega|entregar|pix|pagamento|pagar|amanh[aã]|hoje|sugest[aã]o|sugest[oõ]es|recomenda[cç][aã]o|recomenda[cç][oõ]es)\b/i;

const EXPLICIT_NEW_ORDER_SIGNAL_RE =
  /\b(?:novo|nova|outro|outra)\s+(?:pedido|encomenda)\b|\b(?:pedido|encomenda)\s+(?:novo|nova|separado|independente)\b/i;

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

  const idempotencyKey = next.idempotencyKey ?? computeIdempotencyKeyFromConversation(deps);
  next = { ...next, idempotencyKey };
  const orderInput: AthosOrderWriteInput = {
    organizationId: deps.organizationId,
    contactId: deps.contactId,
    conversationId: deps.conversationId,
    partySize: next.partySize,
    fulfillment: next.fulfillment,
    pickupAtLocal: next.pickupAtLocal,
    pickupTimezone: next.pickupTimezone,
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
        fulfillment: next.fulfillment,
        pickupAtLocal: next.pickupAtLocal,
        pickupTimezone: next.pickupTimezone,
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
  inboundText: string,
  pickup: PickupScheduleResult,
): Promise<RuntimeWiringOutcome> {
  const startsNewOrder = previousSnapshot.state === 'completed' || previousSnapshot.state === 'crm_recorded';
  const baseSnapshot = startsNewOrder
    ? emptyAthosOrderSnapshot()
    : previousSnapshot;
  const merged = mergeCart(
    baseSnapshot.cartItems,
    selection.items,
    /\b(?:mais|adicion(?:a|e|ar)|inclu(?:a|ir)|acrescenta(?:r)?|outr[ao]s?)\b/i.test(inboundText),
  );
  const partySize = baseSnapshot.partySize;
  let next: AthosOrderSnapshot = {
    ...baseSnapshot,
    ...(pickup.kind === 'scheduled' ? {
      fulfillment: 'pickup' as const,
      pickupAtLocal: pickup.value.scheduledAtLocal,
      pickupTimezone: pickup.value.timezone,
    } : {}),
    cartItems: merged,
    state: 'awaiting_confirmation',
    confirmationToken: baseSnapshot.confirmationToken === ''
      ? createConfirmationToken()
      : baseSnapshot.confirmationToken,
    idempotencyKey: baseSnapshot.idempotencyKey ?? newIdempotencyKey(),
    attempts: baseSnapshot.attempts,
    updatedAt: new Date().toISOString(),
  };
  next = await persistAthosSnapshot(deps, next);

  const total = computeTotalCents(next.cartItems);
  const unresolvedText = selection.unresolvedNames.length > 0
    ? `\n\nNao encontrei no cardapio: ${selection.unresolvedNames.join(', ')}.`
    : '';
  const responseText = partySize === null
    ? `Voce selecionou ${merged.length} item(ns). Total parcial: R$ ${(total / 100).toFixed(2)}.${unresolvedText}\n\nPara quantas pessoas sera?`
    : `${orderConfirmationPrompt(next)}${unresolvedText}`;

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
  if (!isRecoverableAthosSnapshot(snapshot) || snapshot.externalOrderId === null) return null;
  const outcome = await buildRecoveryOutcome(
    snapshot,
    {
      organizationId: deps.organizationId,
      contactId: deps.contactId,
      conversationId: deps.conversationId,
      cartItems: snapshot.cartItems,
      partySize: snapshot.partySize,
      fulfillment: snapshot.fulfillment,
      pickupAtLocal: snapshot.pickupAtLocal,
      pickupTimezone: snapshot.pickupTimezone,
      idempotencyKey: snapshot.idempotencyKey ?? computeIdempotencyKeyFromConversation(deps),
      athosCreated: {
        externalOrderId: snapshot.externalOrderId,
        externalStatus: 'created',
        externalPayload: {},
        athosCreatedAt: snapshot.updatedAt,
      },
      externalProvider: 'athos',
    },
    makePgOrderMirrorClient(deps.pool),
  );
  if (outcome.mirror === null) return null;
  const recorded = await persistAthosSnapshot(deps, transitionAthosOrder(snapshot, 'crm_recorded', {
    crmOrderId: outcome.mirror.crmOrderId,
    lastError: null,
  }));
  await persistAthosSnapshot(deps, transitionAthosOrder(recorded, 'completed'));
  return outcome.mirror;
}

function computeTotalCents(items: ReadonlyArray<AthosCartItem>): number {
  return items.reduce((acc, item) => {
    const modifiersDelta = item.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0);
    return acc + item.quantity * (item.unitPriceCents + modifiersDelta);
  }, 0);
}

function orderConfirmationPrompt(snapshot: AthosOrderSnapshot): string {
  const total = computeTotalCents(snapshot.cartItems);
  const lines = snapshot.cartItems.map((item) =>
    `- ${item.quantity}x ${item.productName} (R$ ${((item.unitPriceCents * item.quantity) / 100).toFixed(2)})`,
  );
  const pickup = snapshot.fulfillment === 'pickup' && snapshot.pickupAtLocal
    ? `\nRetirada: ${formatPickupSchedule(snapshot)}.` : '';
  if (snapshot.fulfillment === 'pickup' && !snapshot.pickupAtLocal) {
    return `Pedido para ${snapshot.partySize} pessoa(s). Total: R$ ${(total / 100).toFixed(2)}.\n\n${lines.join('\n')}\n\nPara qual dia e horário será a retirada?`;
  }
  return `Pedido para ${snapshot.partySize} pessoa(s). Total: R$ ${(total / 100).toFixed(2)}.\n\n${lines.join('\n')}${pickup}\n\nConfirma o pedido? Responda "confirmo o pedido" para enviar a Athos.`;
}

function stripPickupClause(text: string): string {
  return text.replace(/(?:\s+para\s+retirada\b|\s+retirada\b|\s+amanh[aã](?!\p{L})|\s+hoje\b|\s+\d{1,2}\/\d{1,2}(?:\/\d{4})?\b).*$/iu, '').trim();
}

function formatPickupSchedule(snapshot: AthosOrderSnapshot): string {
  const match = snapshot.pickupAtLocal?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]} às ${match[4]}:${match[5]}` : 'horário a confirmar';
}

function mergeCart(
  current: ReadonlyArray<AthosCartItem>,
  incoming: ReadonlyArray<AthosCartItem>,
  additive: boolean,
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
        // Repetir o mesmo pedido corrige/ratifica a quantidade. Só uma
        // intenção explícita de acréscimo soma ao carrinho anterior.
        quantity: additive ? existing.quantity + item.quantity : item.quantity,
      });
    }
  }
  return Array.from(map.values());
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

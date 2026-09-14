/**
 * Recovery da transicao `athos_created` → `crm_recorded` (briefing
 * recovery Athos × Sarah E2E 2026-09-13).
 *
 * Cenario: o adapter Athos respondeu com external_order_id (estado
 * `athos_created`) e o worker caiu antes do espelho CRM gravar o
 * `orders`. No proximo run, o recovery encontra o snapshot
 * `athos_created` (sem `crm_recorded`) e retenta o espelho.
 *
 * Idempotencia: o espelho usa a `idempotencyKey` original. Mesmo se o
 * espelho rodar 2x (ex.: crash antes do UPDATE crm_order_id no
 * snapshot), o `insertOrderWithIdempotency` do OrderMirrorClient retorna
 * `wasReplay=true` no segundo insert — sem duplicar orders.
 */

import type { OrderMirrorClient, OrderMirrorResult } from './order-mirror';
import { isRecoverableAthosSnapshot, mirrorAthosOrderToCrm } from './order-mirror';
import type { AthosCartItem, AthosOrderSnapshot, AthosOrderState } from './order-state';
import { transitionAthosOrder } from './order-state';
import type { AthosOrderWriteResult } from './order-adapter';

export interface RecoveryInput {
  organizationId: string;
  contactId: string;
  conversationId: string;
  cartItems: ReadonlyArray<AthosCartItem>;
  partySize: number | null;
  idempotencyKey: string;
  athosCreated: AthosOrderWriteResult;
  externalProvider: 'gm_crm_food' | 'athos';
}

export interface RecoveryOutcome {
  recovered: boolean;
  finalState: AthosOrderState;
  mirror: OrderMirrorResult | null;
}

export function buildRecoveryOutcome(
  snapshot: AthosOrderSnapshot,
  recovery: RecoveryInput,
  client: OrderMirrorClient,
): Promise<RecoveryOutcome> {
  if (!isRecoverableAthosSnapshot(snapshot)) {
    return Promise.resolve({
      recovered: false,
      finalState: snapshot.state,
      mirror: null,
    });
  }
  return runRecovery(snapshot, recovery, client);
}

async function runRecovery(
  snapshot: AthosOrderSnapshot,
  recovery: RecoveryInput,
  client: OrderMirrorClient,
): Promise<RecoveryOutcome> {
  const mirror = await mirrorAthosOrderToCrm(client, {
    organizationId: recovery.organizationId,
    contactId: recovery.contactId,
    conversationId: recovery.conversationId,
    athosCreated: recovery.athosCreated,
    cartItems: recovery.cartItems,
    partySize: recovery.partySize,
    idempotencyKey: recovery.idempotencyKey,
    externalProvider: recovery.externalProvider,
  });
  const next = transitionAthosOrder(snapshot, 'crm_recorded', {
    crmOrderId: mirror.crmOrderId,
    lastError: null,
  });
  return {
    recovered: true,
    finalState: next.state,
    mirror,
  };
}

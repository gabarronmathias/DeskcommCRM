/**
 * Persistencia do estado comercial foodservice em conversations.metadata
 * (briefing recovery Athos × Sarah E2E 2026-09-13).
 *
 * SEM migration: usa a coluna `conversations.metadata` (jsonb) que ja
 * existe no schema. O snapshot persistido é exatamente
 * `AthosOrderSnapshot` (ver order-state.ts) — party_size, cartItems,
 * confirmationToken, externalOrderId, crmOrderId, attempts, lastError.
 *
 * Concorrencia: o write usa `conversations.metadata || jsonb_build_object(...)`
 * para fundir com o metadata existente (nao destrutivo). O caller deve
 * sempre ler antes de escrever pra nao sobrescrever campos que outros
 * modulos estao usando.
 *
 * LGPD: o cart nao persiste numero de cartao, CVV, ou documento — apenas
 * itens, party_size, datas e identificadores de idempotencia. O snapshot
 * e anonimizado quando o contato e anonimizado (regra 6 da LGPD do
 * briefing: cascade redact preserva timestamps).
 */

import type { AthosOrderSnapshot } from './order-state';
import { emptyAthosOrderSnapshot } from './order-state';

export const ATHOS_METADATA_KEY = 'athos_order';

export interface ConversationMetadataRow {
  metadata: Record<string, unknown> | null;
}

export function readAthosOrderFromMetadata(
  metadata: ConversationMetadataRow['metadata'],
): AthosOrderSnapshot {
  if (metadata === null) return emptyAthosOrderSnapshot();
  const value = metadata[ATHOS_METADATA_KEY];
  if (value === null || value === undefined || typeof value !== 'object') {
    return emptyAthosOrderSnapshot();
  }
  return value as AthosOrderSnapshot;
}

export function writeAthosOrderToMetadata(
  metadata: ConversationMetadataRow['metadata'] | null,
  snapshot: AthosOrderSnapshot,
): Record<string, unknown> {
  const base = metadata ?? {};
  return {
    ...base,
    [ATHOS_METADATA_KEY]: snapshot,
  };
}

/**
 * Persiste party_size em contacts.source_metadata (jsonb existente — sem
 * migration). O snapshot de party_size fica em
 * `source_metadata.foodservice.party_size`. O resto do estado comercial
 * continua em conversations.metadata.
 */
export interface ContactSourceMetadataRow {
  source_metadata: Record<string, unknown> | null;
}

export interface FoodserviceContactState {
  party_size: number | null;
  updated_at: string;
}

export function readFoodservicePartySize(
  sourceMetadata: ContactSourceMetadataRow['source_metadata'],
): number | null {
  if (sourceMetadata === null) return null;
  const value = sourceMetadata['foodservice'];
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const partySize = (value as Record<string, unknown>)['party_size'];
  return typeof partySize === 'number' ? partySize : null;
}

export function writeFoodservicePartySize(
  sourceMetadata: ContactSourceMetadataRow['source_metadata'] | null,
  partySize: number,
): Record<string, unknown> {
  const base = sourceMetadata ?? {};
  const foodservice = {
    ...((base['foodservice'] as Record<string, unknown> | undefined) ?? {}),
    party_size: partySize,
    updated_at: new Date().toISOString(),
  };
  return {
    ...base,
    foodservice,
  };
}

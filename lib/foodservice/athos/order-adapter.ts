/**
 * Adapter boundary para escrita de pedido na Athos (briefing recovery
 * Athos × Sarah E2E 2026-09-13).
 *
 * O adapter NAO faz HTTP: ele é uma CAPABILITY BOUNDARY explícita. Quando o
 * env `ATHOS_ORDER_WRITE_ENDPOINT` (ou um hook configurável equivalente)
 * estiver ausente, `createAthosOrder` levanta `ATHOS_ORDER_WRITE_UNAVAILABLE`
 * — sem fallback silencioso para "criar só no CRM". Sem contrato/API
 * autorizada de escrita Athos, o sistema NÃO pode dizer ao cliente que o
 * pedido foi criado na Athos.
 *
 * O adapter expõe dois caminhos:
 *   1. `createAthosOrder(input)` — usado em runtime pelo motor de Sarah
 *      foodservice após confirmação do cliente.
 *   2. `setAthosAdapter(impl)`   — injeção de implementação para tests
 *      (ex.: fake adapter em tests/unit/athos-order-replay.test.ts).
 *
 * A interface `AthosOrderAdapter.createAthosOrder` retorna
 * `AthosOrderWriteResult` com `externalOrderId` (string) — o mesmo
 * identificador que vai para `orders.external_id` no mirror do CRM.
 *
 * Idempotência: o adapter NÃO deduplica por si. A chave de idempotência
 * vem do caller (`input.idempotencyKey`) e deve ser persistida em
 * `idempotency_keys` antes da chamada. O fake adapter de test usa essa
 * chave pra garantir que 5 replays da mesma confirmação resultem em
 * exatamente 1 pedido criado (ver tests/unit/athos-order-replay.test.ts).
 */

import type { AthosCartItem } from './order-state';

export interface AthosOrderWriteInput {
  organizationId: string;
  contactId: string;
  partySize: number | null;
  cartItems: ReadonlyArray<AthosCartItem>;
  idempotencyKey: string;
  confirmationToken: string;
  totalCents: number;
}

export interface AthosOrderWriteResult {
  externalOrderId: string;
  externalStatus: string;
  externalPayload: Record<string, unknown>;
  athosCreatedAt: string;
}

export interface AthosOrderAdapter {
  readonly provider: 'athos';
  isConfigured(): boolean;
  createAthosOrder(input: AthosOrderWriteInput): Promise<AthosOrderWriteResult>;
}

export const ATHOS_ORDER_WRITE_UNAVAILABLE = 'athos_order_write_unavailable';

let activeAdapter: AthosOrderAdapter | null = null;

export function setAthosAdapter(adapter: AthosOrderAdapter | null): void {
  activeAdapter = adapter;
}

export function getAthosAdapter(): AthosOrderAdapter | null {
  return activeAdapter;
}

export function clearAthosAdapter(): void {
  activeAdapter = null;
}

/**
 * Runtime adapter — bloqueado por boundary externo. Quando o env
 * `ATHOS_ORDER_WRITE_ENDPOINT` nao esta configurado (e nenhum adapter foi
 * injetado via setAthosAdapter), o adapter retorna
 * ATHOS_ORDER_WRITE_UNAVAILABLE — sem fallback silencioso.
 */
export const athosRuntimeAdapter: AthosOrderAdapter = {
  provider: 'athos',
  isConfigured(): boolean {
    return process.env['ATHOS_ORDER_WRITE_ENDPOINT'] !== undefined &&
      process.env['ATHOS_ORDER_WRITE_ENDPOINT'] !== '';
  },
  async createAthosOrder(): Promise<AthosOrderWriteResult> {
    const err = new Error(
      `${ATHOS_ORDER_WRITE_UNAVAILABLE}: endpoint de escrita Athos nao configurado; `
        + `defina ATHOS_ORDER_WRITE_ENDPOINT ou injete adapter via setAthosAdapter`,
    ) as Error & { code: string };
    err.code = ATHOS_ORDER_WRITE_UNAVAILABLE;
    throw err;
  },
};

export async function createAthosOrder(input: AthosOrderWriteInput): Promise<AthosOrderWriteResult> {
  const adapter = activeAdapter ?? athosRuntimeAdapter;
  if (!adapter.isConfigured()) {
    const err = new Error(
      `${ATHOS_ORDER_WRITE_UNAVAILABLE}: adapter Athos order-write nao configurado`,
    ) as Error & { code: string };
    err.code = ATHOS_ORDER_WRITE_UNAVAILABLE;
    throw err;
  }
  return adapter.createAthosOrder(input);
}

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
import { createHmac, randomUUID } from 'node:crypto';

export interface AthosOrderWriteInput {
  organizationId: string;
  contactId: string;
  conversationId: string;
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

interface AthosSandboxConfig {
  endpoint: string;
  bearerToken: string;
  hmacSecret: string;
  storeRef: string;
  timeoutMs: number;
}

function readSandboxConfig(env: NodeJS.ProcessEnv = process.env): AthosSandboxConfig | null {
  const endpoint = env['ATHOS_ORDER_WRITE_ENDPOINT']?.replace(/\/+$/, '');
  const bearerToken = env['ATHOS_BEARER_TOKEN'];
  const hmacSecret = env['ATHOS_HMAC_SECRET'];
  const storeRef = env['ATHOS_STORE_REF'];
  if (!endpoint || !bearerToken || !hmacSecret || !storeRef) return null;
  try {
    if (!new URL(endpoint).pathname.replace(/\/+$/, '').endsWith('/athos-sandbox')) return null;
  } catch {
    return null;
  }
  return { endpoint, bearerToken, hmacSecret, storeRef, timeoutMs: 15_000 };
}

function athosError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ response: Response; json: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      // A malformed/non-JSON provider response is reported by status only.
    }
    return { response, json };
  } catch {
    throw athosError('athos_http_request_failed');
  } finally {
    clearTimeout(timeout);
  }
}

function nestedData(json: Record<string, unknown>): Record<string, unknown> {
  const data = json['data'];
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
}

/** Runtime adapter for the configured Athos sandbox event contract. */
async function writeAthosSandboxOrder(
  input: AthosOrderWriteInput,
  config: AthosSandboxConfig,
): Promise<AthosOrderWriteResult> {
  const authorization = { Authorization: `Bearer ${config.bearerToken}` };
  const items = input.cartItems.map((item) => {
    if (!item.externalProductId) throw athosError('athos_item_mapping_missing');
    if (!item.sku?.trim()) throw athosError('athos_item_sku_missing');
    const unitPriceCents = item.unitPriceCents + item.modifiers.reduce((sum, modifier) => sum + modifier.priceDeltaCents, 0);
    return {
      product_id: item.externalProductId,
      sku: item.sku,
      name: item.productName,
      quantity: item.quantity,
      unit_price_cents: unitPriceCents,
      line_total_cents: item.quantity * unitPriceCents,
      modifiers: item.modifiers.map((modifier) => ({ name: modifier.name, price_delta_cents: modifier.priceDeltaCents })),
    };
  });
  const launch = await postJson(
    `${config.endpoint}/test-launch`,
    { store_ref: config.storeRef },
    authorization,
    config.timeoutMs,
  );
  if (!launch.response.ok) throw athosError(`athos_launch_http_${launch.response.status}`);
  const launchData = nestedData(launch.json);
  if (launchData['environment'] !== 'sandbox') throw athosError('athos_launch_not_sandbox');
  const launchId = launchData['launch_id'];
  const crmContactId = launchData['crm_contact_id'];
  if (typeof launchId !== 'string' || typeof crmContactId !== 'string') {
    throw athosError('athos_launch_response_invalid');
  }

  const now = new Date().toISOString();
  const eventId = input.idempotencyKey || randomUUID();
  const event = {
    event_id: eventId,
    event_type: 'order.created',
    occurred_at: now,
    store_ref: config.storeRef,
    correlation: { launch_id: launchId, crm_contact_id: crmContactId },
    customer: { name: 'Cliente Sandbox Sarah', phone: '11999999999' },
    order: {
      id: eventId,
      status: 'pending',
      currency: 'BRL',
      total_cents: input.totalCents,
      created_at: now,
      updated_at: now,
      ...(input.partySize === null ? {} : { party_size: input.partySize }),
      items,
    },
  };
  const rawBody = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac('sha256', config.hmacSecret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const result = await postJson(
    `${config.endpoint}/events`,
    event,
    { ...authorization, 'X-Athos-Timestamp': timestamp, 'X-Athos-Signature': signature },
    config.timeoutMs,
  );
  if (!result.response.ok) {
    const error = result.json['error'];
    const errorBody = error !== null && typeof error === 'object'
      ? error as Record<string, unknown>
      : {};
    const safeCode = typeof errorBody['message'] === 'string'
      ? errorBody['message'].replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
      : `http_${result.response.status}`;
    throw athosError(`athos_event_${safeCode}`);
  }
  const data = nestedData(result.json);
  if (data['accepted'] !== true) throw athosError('athos_event_not_accepted');
  const externalOrderId = data['order_id'];
  return {
    // The event's order.id is the idempotency key, so this is safe on the
    // sandbox duplicate response, which does not include order_id.
    externalOrderId: typeof externalOrderId === 'string' ? externalOrderId : eventId,
    externalStatus: 'accepted',
    externalPayload: result.json,
    athosCreatedAt: now,
  };
}

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
    return readSandboxConfig() !== null;
  },
  async createAthosOrder(input: AthosOrderWriteInput): Promise<AthosOrderWriteResult> {
    const config = readSandboxConfig();
    if (!config) throw athosError(ATHOS_ORDER_WRITE_UNAVAILABLE);
    return writeAthosSandboxOrder(input, config);
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

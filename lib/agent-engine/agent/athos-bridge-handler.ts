/**
 * Bridge runtime entre inbound-turn.ts e o modulo
 * lib/foodservice/athos/runtime-wiring (briefing recovery Athos x Sarah E2E
 * 2026-09-13, branch fix/sarah-athos-e2e-runtime).
 *
 * Quando o fast path foodservice NAO casa (matched=false), tentamos o
 * bridge Athos para dois casos deterministicos:
 *   1. cart_selection — cliente escolhe itens do catalogo real
 *   2. confirmation    — cliente confirma explicitamente ("confirmo", "pode
 *                        fechar", "fechar pedido")
 *
 * Quando handled=true, o caller reusa o caminho de runBeforeSend com uma
 * synthetic decision (kind='athos_bridge') para preservar a cadeia de
 * safety.
 *
 * Quando handled=false, o caller segue para o full pipeline (LLM).
 */

import type pg from 'pg';

import type { Logger } from '../obs/logger';
import {
  handleFoodserviceOrderTurn,
  type RuntimeWiringOutcome,
} from '../../foodservice/athos/runtime-wiring';

export interface AthosBridgeHandlerDeps {
  pool: pg.Pool;
  organizationId: string;
  contactId: string;
  conversationId: string;
  tenantSlug: string | null;
  text: string;
  log: Logger;
}

export interface AthosBridgeResult {
  reason: string;
  responseText: string;
  outcome: RuntimeWiringOutcome;
}

export async function tryHandleAthosOrderBridge(
  deps: AthosBridgeHandlerDeps,
): Promise<AthosBridgeResult | null> {
  if (deps.tenantSlug === null || deps.tenantSlug === '') {
    deps.log.info('athos-bridge: tenantSlug ausente — segue para full pipeline');
    return null;
  }
  const outcome = await handleFoodserviceOrderTurn(
    {
      pool: deps.pool,
      organizationId: deps.organizationId,
      contactId: deps.contactId,
      conversationId: deps.conversationId,
      tenantSlug: deps.tenantSlug,
    },
    deps.text,
  );
  if (!outcome.handled) {
    return null;
  }
  return {
    reason: `athos_bridge_${outcome.state}`,
    responseText: outcome.responseText,
    outcome,
  };
}

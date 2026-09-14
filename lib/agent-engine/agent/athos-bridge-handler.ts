/**
 * Bridge runtime entre inbound-turn.ts e o modulo
 * lib/foodservice/athos/runtime-wiring (briefing recovery Athos x Sarah E2E
 * 2026-09-13, branch fix/sarah-athos-e2e-runtime).
 *
 * Quando o fast path foodservice NAO casa (matched=false), tentamos o
 * bridge Athos para dois casos deterministicos:
 *   1. cart_selection — cliente escolhe itens do catalogo CRM configurado
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
import { resolveEnabledAthosTenantSlug } from '../../foodservice/athos/runtime-repository';

export interface AthosBridgeHandlerDeps {
  pool: pg.Pool;
  organizationId: string;
  contactId: string;
  conversationId: string;
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
  const tenantSlug = await resolveEnabledAthosTenantSlug(deps.pool, deps.organizationId);
  if (tenantSlug === null) {
    deps.log.info('athos-bridge: food commerce desabilitado — segue para full pipeline');
    return null;
  }
  const outcome = await handleFoodserviceOrderTurn(
    {
      pool: deps.pool,
      organizationId: deps.organizationId,
      contactId: deps.contactId,
      conversationId: deps.conversationId,
      tenantSlug,
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

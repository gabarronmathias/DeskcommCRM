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
  const transactionalSignal = TRANSACTIONAL_ORDER_SIGNAL_RE.test(deps.text);
  let tenantSlug: string | null;
  try {
    tenantSlug = await resolveEnabledAthosTenantSlug(deps.pool, deps.organizationId);
  } catch (err) {
    if (!transactionalSignal) throw err;
    return failClosed(deps, err);
  }
  if (tenantSlug === null) {
    deps.log.info('athos-bridge: food commerce desabilitado — segue para full pipeline');
    if (transactionalSignal) {
      return failClosed(deps, new Error('food_commerce_disabled'));
    }
    return null;
  }
  let outcome: RuntimeWiringOutcome;
  try {
    outcome = await handleFoodserviceOrderTurn(
      {
        pool: deps.pool,
        organizationId: deps.organizationId,
        contactId: deps.contactId,
        conversationId: deps.conversationId,
        tenantSlug,
      },
      deps.text,
    );
  } catch (err) {
    if (!transactionalSignal) throw err;
    return failClosed(deps, err);
  }
  if (!outcome.handled) {
    return null;
  }
  return {
    reason: `athos_bridge_${outcome.state}`,
    responseText: outcome.responseText,
    outcome,
  };
}

const TRANSACTIONAL_ORDER_SIGNAL_RE =
  /\b(?:pedido|encomenda|confirm(?:o|ar|ado|ada)|pode fechar|fechar pedido|tortas?|bolos?|doces?|salgados?|retirada|retirar|delivery|entrega|entregar|pix|pagamento|pagar)\b/i;

function failClosed(deps: AthosBridgeHandlerDeps, error: unknown): AthosBridgeResult {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'athos_order_check_failed';
  deps.log.warn('athos-bridge: pedido bloqueado sem confirmação verificável', {
    error_code: code,
  });
  const responseText = /\b(?:card[aá]pio|menu)\b/i.test(deps.text)
    ? 'Não consegui consultar o cardápio agora. Nenhum pedido foi registrado; tente novamente em alguns instantes.'
    : 'Não consegui verificar o registro do pedido agora. Ele ainda não está confirmado por aqui. Para evitar duplicidade, aguarde a conferência da equipe.';
  const outcome: RuntimeWiringOutcome = {
    handled: true,
    responseText,
    partySize: null,
    cartItems: [],
    state: 'no_change',
    errorCode: code,
  };
  return {
    reason: 'athos_bridge_failed_closed',
    responseText,
    outcome,
  };
}

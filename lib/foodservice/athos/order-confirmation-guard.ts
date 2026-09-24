import type pg from 'pg';

const VERIFIED_ORDER_WINDOW_HOURS = 48;

/** Detect only assertions that an order has already been completed or recorded. */
export function claimsOrderWasConfirmed(text: string): boolean {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(?:nao|ainda nao)\b[^.!?\n]{0,100}\b(?:pedido|confirmad|registrad|concluid)\b/.test(normalized)) {
    return false;
  }
  return /\b(?:seu|o) pedido (?:ja )?(?:(?:esta|foi|ficou) )?(?:confirmado|registrado|concluido|fechado)\b/.test(normalized)
    || /\bpedido (?:confirmado|registrado|concluido|fechado)\b/.test(normalized)
    || /\b(?:confirmei|registrei|fechei|finalizei)\s*(?::|(?:o|seu) pedido\b)/.test(normalized);
}

/**
 * The LLM cannot acknowledge an Athos order merely because the conversation
 * sounds complete. Fail closed if the database check itself fails.
 */
export async function shouldBlockUnverifiedAthosConfirmation(
  pool: pg.Pool,
  organizationId: string,
  contactId: string,
  conversationId: string,
): Promise<boolean> {
  const result = await pool.query<{ enabled: boolean; verified: boolean }>(
    `select exists (
       select 1 from food_commerce_settings
        where organization_id = $1 and is_enabled = true
     ) as enabled,
     exists (
       select 1
         from conversations c
         join orders o on o.id::text = c.metadata #>> '{athos_order,crmOrderId}'
        where c.organization_id = $1
          and c.contact_id = $2
          and c.id = $3
          and c.metadata #>> '{athos_order,state}' = 'completed'
          and o.organization_id = c.organization_id
          and o.contact_id = c.contact_id
          and o.external_provider = 'athos'
          and o.external_id is not null
          and o.created_at >= now() - ($4::int * interval '1 hour')
     ) as verified`,
    [organizationId, contactId, conversationId, VERIFIED_ORDER_WINDOW_HOURS],
  );
  return result.rows[0]?.enabled === true && result.rows[0]?.verified !== true;
}

export const UNVERIFIED_ATHOS_ORDER_REPLY =
  'Não tenho confirmação de que este pedido foi registrado no sistema. ' +
  'Para evitar um erro, ele ainda não está confirmado por aqui.';

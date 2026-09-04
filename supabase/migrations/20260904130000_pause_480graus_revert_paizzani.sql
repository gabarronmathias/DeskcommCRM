-- ============================================================================
-- 2026-09-04 13:00 — Pausa de 480 Graus e reversão do estado Paizzani
--
-- Contexto (ver reports):
--   - Paizzani autoresponder foi tratado como reply humano:
--     last_reply_at preenchido, follow-up D+2 cancelado, Sarah tentou
--     responder e falhou (WAHA session "default" não existe).
--   - 480 Graus ainda é pending na campanha gb-foodservice-sjc-2026-09.
--     DEVE ser pausada até a correção do autoresponder ser deployada e
--     certificada.
--
-- Este script é AUDITÁVEL e não destrutivo:
--   1. 480 Graus: queue row marcada como `cancelled` com reason
--      `manual_pause_awaiting_autoresponder_fix` (mantém o histórico).
--   2. Paizzani: reverte last_reply_at e next_followup_at no lead,
--      e ressuscita a follow-up que foi cancelada com `error_code='replied'`.
--   3. Não toca em messages (preserva o inbound + a tentativa failed de Sarah).
--   4. Idempotente — pode ser re-executado sem efeito.
-- ============================================================================

-- 1) PAUSAR 480 Graus
UPDATE prospecting_outbound_queue
SET status = 'cancelled',
    error_code = 'manual_pause_awaiting_autoresponder_fix',
    error_message = 'Pausado manualmente em 2026-09-04 até certificação do fix de autoresponder.',
    updated_at = now()
WHERE id = '6c2dfab9-ab01-4dcb-9f02-c78167ea6c0a'
  AND status IN ('pending', 'processing');

-- 2) REVERTER Paizzani
-- 2a) Reverter last_reply_at e next_followup_at no lead (custom_fields).
UPDATE crm_leads cl
SET custom_fields = jsonb_set(
  jsonb_set(
    cl.custom_fields,
    '{last_reply_at}',
    'null'::jsonb
  ),
  '{next_followup_at}',
    'null'::jsonb
)
FROM prospecting_outbound_queue q
WHERE q.id = 'bb9d09a3-9e30-4936-9880-75513af9da32'
  AND q.lead_id = cl.id
  AND q.metadata->>'campaign' = 'gb-foodservice-sjc-2026-09';

-- 2b) Ressuscitar a follow-up D+2 que foi cancelada com reason='replied'
UPDATE prospecting_outbound_queue
SET status = 'pending',
    error_code = NULL,
    error_message = NULL,
    scheduled_for = COALESCE(NULLIF(scheduled_for, NULL), now() + interval '48 hours'),
    updated_at = now()
WHERE lead_id IN (
    SELECT lead_id FROM prospecting_outbound_queue
    WHERE id = 'bb9d09a3-9e30-4936-9880-75513af9da32'
  )
  AND kind = 'followup'
  AND status = 'cancelled'
  AND error_code = 'replied';
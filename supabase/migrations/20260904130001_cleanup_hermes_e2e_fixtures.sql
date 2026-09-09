-- ============================================================================
-- 2026-09-04 13:00:01 — Cleanup dos fixtures do E2E Hermes em
-- gb-hermes-integration-test e gb-hermes-integration-test-other.
--
-- Contexto: o E2E de integração Hermes ↔ DeskcommCRM (commit 65da2d09
-- em produção) criou 3 prospects de teste:
--   - C1 (campaign=gb-hermes-integration-test): STATUS=created → pending
--   - C2 (campaign=gb-hermes-integration-test-other): STATUS=created → pending
--   - C3 (campaign=gb-hermes-integration-test): STATUS=created → pending
--   - C-INV (phone inválido): rejeitado pelo validador (sem row criada)
--   - C1-DUP (mesmo sourceId): rejected por dedupe
--
-- O dispatcher FILTRA por activeCampaign() (gb-foodservice-sjc-2026-09), então
-- as rows de teste NUNCA serão despachadas para WhatsApp real. Esta migration
-- é limpeza AUDITÁVEL, não destrutiva: marca as rows como `cancelled` com
-- reason `cleanup_hermes_e2e_fixture` e mantém o histórico.
--
-- A migration é IDEMPOTENTE — pode rodar mais de uma vez sem efeito colateral.
-- ============================================================================

-- Marca as queue rows de teste como cancelled (auditável)
UPDATE prospecting_outbound_queue q
SET status = 'cancelled',
    error_code = 'cleanup_hermes_e2e_fixture',
    error_message = 'E2E Hermes 2026-09-04 — cleanup do fixture ' || q.kind || ' da campanha de teste.',
    updated_at = now()
WHERE q.metadata->>'campaign' IN ('gb-hermes-integration-test', 'gb-hermes-integration-test-other')
  AND q.status IN ('pending', 'processing');

-- Reverte o prospecting_status dos leads de teste para fora do estado 'queued'
-- (para futuras listagens não mostrarem como se o robô estivesse prestes a
-- mandar mensagem). Mantém o histórico de inbound/outbound em messages.
UPDATE crm_leads cl
SET custom_fields = jsonb_set(
  cl.custom_fields,
  '{prospecting_status}',
  '"archived"'
)
FROM prospecting_outbound_queue q
WHERE q.lead_id = cl.id
  AND q.metadata->>'campaign' IN ('gb-hermes-integration-test', 'gb-hermes-integration-test-other')
  AND q.status = 'cancelled'
  AND q.error_code = 'cleanup_hermes_e2e_fixture';

-- Auditoria: registra a operação no event_log
SELECT emit_event(
  'hermes.e2e_fixtures_cleanup',
  'prospecting_outbound_queue',
  'cleanup_hermes_e2e_2026_09_04',
  jsonb_build_object(
    'campaigns_cleaned', jsonb_build_array('gb-hermes-integration-test', 'gb-hermes-integration-test-other'),
    'reason', 'cleanup_hermes_e2e_fixture',
    'cleaned_at', now()
  ),
  jsonb_build_object('severity', 'info'),
  (SELECT organization_id FROM prospecting_outbound_queue q WHERE q.metadata->>'campaign' IN ('gb-hermes-integration-test','gb-hermes-integration-test-other') LIMIT 1)
);

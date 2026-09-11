-- 2026-09-09 12:00:00 — Rebrand G&M CRM
-- Renomeia o external_provider `deskcomm_food` para `gm_crm_food` em orders e
-- preserva o histórico. Idempotente: idempotency_key continua única no destino
-- e a checagem de `existing_external_provider` é WHERE external_provider = old.

update orders
   set external_provider = 'gm_crm_food'
 where external_provider = 'deskcomm_food';

-- Nada a fazer em idempotency_keys porque o identificador de idempotência é
-- por (org, chave) e a chave é gerada pelo cliente (não tem "deskcomm" no nome).

-- 0178_orders_external_provider_athos
-- 2026-09-13 22:00:00 — orders.external_provider = 'athos'
-- Briefing recovery Athos x Sarah E2E 2026-09-13.
--
-- Adiciona 'athos' ao CHECK orders_external_provider_check para que o mirror
-- do pedido Athos possa gravar a origem fiel no CRM (sem o workaround
-- 'gm_crm_food' + external_payload.source='athos'). Preserva todos os
-- providers existentes (nuvemshop, vtex, shopify, deskcomm_food,
-- gm_crm_food) — NUNCA remove valores.
--
-- Idempotente:
--   1. drop constraint if exists orders_external_provider_check
--   2. add constraint com a lista atual + 'athos'
--
-- Sem efeito colateral em pedidos já existentes (CHECK é só em INSERT/UPDATE).
-- Nao mexe em indices, RLS, funcoes ou policies. Nao aplica migration 0094.

alter table public.orders
  drop constraint if exists orders_external_provider_check;

alter table public.orders
  add constraint orders_external_provider_check
  check (external_provider = any (array[
    'nuvemshop'::text,
    'vtex'::text,
    'shopify'::text,
    'deskcomm_food'::text,
    'gm_crm_food'::text,
    'athos'::text
  ]));

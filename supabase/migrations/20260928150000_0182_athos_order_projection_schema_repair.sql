-- 0182_athos_order_projection_schema_repair
-- Reasserts the minimum schema contract required by fn_apply_athos_order_event
-- on self-hosted installs where individual Athos migrations may have been
-- applied manually or out of sequence.

alter table public.orders
  add column if not exists athos_event_id text;

alter table public.food_order_items
  add column if not exists external_product_id text,
  add column if not exists external_sku text;

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

-- Repeatable evidence for the isolated Athos CRM pilot.
-- Creates only synthetic records in the dedicated pilot tenant.

begin;

create temp table _athos_e2e_ctx (
  connection_id uuid not null,
  organization_id uuid not null,
  contact_id uuid not null,
  conversation_id uuid not null,
  launch_id uuid not null,
  external_order_id text not null,
  created_event_id text not null,
  status_event_id text not null,
  canonical_order_id uuid
) on commit drop;

create temp table _athos_e2e_assertions (
  check_name text primary key,
  passed boolean not null,
  observed text,
  expected text
) on commit drop;

insert into _athos_e2e_ctx (
  connection_id,
  organization_id,
  contact_id,
  conversation_id,
  launch_id,
  external_order_id,
  created_event_id,
  status_event_id
) values (
  '1acdc3e8-488e-4539-90aa-869ed73de966',
  'd31a7319-c347-40f6-96f1-640353a97ae0',
  '3f77b76e-d174-4ab5-82f0-7cd81e4b67d6',
  '0543115e-5215-4e85-b736-77baeb664952',
  'd8a86b8f-7d36-4e6e-9dd1-8a9b1b8db8e1',
  'crm-e2e-' || gen_random_uuid()::text,
  'evt-crm-created-' || gen_random_uuid()::text,
  'evt-crm-status-' || gen_random_uuid()::text
);

with event_payload as (
  select
    c.*,
    jsonb_build_object(
      'event_id', c.created_event_id,
      'event_type', 'order.created',
      'occurred_at', '2026-09-08T13:00:00Z',
      'store_ref', '5b7b4a38-4c54-488e-986f-9ea0428cff7a',
      'order', jsonb_build_object(
        'id', c.external_order_id,
        'status', 'confirmed',
        'total_cents', 5500,
        'currency', 'BRL',
        'created_at', '2026-09-08T13:00:00Z',
        'updated_at', '2026-09-08T13:00:00Z',
        'items', jsonb_build_array(jsonb_build_object(
          'product_id', 'e2e-product',
          'sku', 'E2E-001',
          'name', 'Pedido sintetico de homologacao',
          'quantity', 1,
          'unit_price_cents', 5500,
          'line_total_cents', 5500,
          'modifiers', jsonb_build_array()
        ))
      ),
      'customer', jsonb_build_object(
        'athos_customer_id', 'e2e-customer',
        'name', 'Cliente Sintetico',
        'phone', '+5511999999999'
      ),
      'correlation', jsonb_build_object(
        'launch_id', c.launch_id,
        'crm_contact_id', c.contact_id,
        'crm_conversation_id', c.conversation_id
      )
    ) as payload
  from _athos_e2e_ctx c
), receipt as (
  insert into public.athos_sandbox_events (
    connection_id,
    event_id,
    event_type,
    occurred_at,
    store_ref,
    external_order_id,
    payload
  )
  select
    connection_id,
    created_event_id,
    'order.created',
    '2026-09-08T13:00:00Z'::timestamptz,
    '5b7b4a38-4c54-488e-986f-9ea0428cff7a',
    external_order_id,
    payload
  from event_payload
  returning id
)
select count(*) as created_receipts from receipt;

-- Materialize the exact synthetic receipt before invoking the projecting
-- function. SQL predicate evaluation order is not guaranteed; placing the
-- function directly in UPDATE ... WHERE allowed PostgreSQL to evaluate it for
-- older partner receipts that intentionally have no CRM-tenant correlation.
with target_receipt as materialized (
  select e.id, e.connection_id, e.payload
  from public.athos_sandbox_events e
  join _athos_e2e_ctx c
    on c.connection_id = e.connection_id
   and c.created_event_id = e.event_id
), applied as materialized (
  select
    id,
    public.fn_apply_athos_sandbox_order_snapshot(connection_id, payload) as crm_order_id
  from target_receipt
)
update public.athos_sandbox_events e
set status = 'processed', processed_at = now(), error_message = null
from applied a
where e.id = a.id
  and a.crm_order_id is not null;

update _athos_e2e_ctx c
set canonical_order_id = o.id
from public.orders o
where o.organization_id = c.organization_id
  and o.external_provider = 'deskcomm_food'
  and o.external_id = 'athos:' || c.external_order_id;

insert into _athos_e2e_assertions
select
  'order.created projected once',
  count(*) = 1,
  count(*)::text,
  '1 canonical order'
from public.orders o
join _athos_e2e_ctx c
  on o.organization_id = c.organization_id
 and o.external_provider = 'deskcomm_food'
 and o.external_id = 'athos:' || c.external_order_id;

with duplicate_attempt as (
  insert into public.athos_sandbox_events (
    connection_id,
    event_id,
    event_type,
    occurred_at,
    store_ref,
    external_order_id,
    payload
  )
  select
    e.connection_id,
    e.event_id,
    e.event_type,
    e.occurred_at,
    e.store_ref,
    e.external_order_id,
    e.payload
  from public.athos_sandbox_events e
  join _athos_e2e_ctx c
    on e.connection_id = c.connection_id
   and e.event_id = c.created_event_id
  on conflict (connection_id, event_id) do nothing
  returning 1
)
insert into _athos_e2e_assertions
select
  'duplicate event is idempotent',
  count(*) = 0,
  count(*)::text,
  '0 duplicate receipts'
from duplicate_attempt;

with event_payload as (
  select
    c.*,
    jsonb_build_object(
      'event_id', c.status_event_id,
      'event_type', 'order.status_changed',
      'occurred_at', '2026-09-08T13:10:00Z',
      'store_ref', '5b7b4a38-4c54-488e-986f-9ea0428cff7a',
      'order', jsonb_build_object(
        'id', c.external_order_id,
        'status', 'preparing',
        'total_cents', 5500,
        'currency', 'BRL',
        'created_at', '2026-09-08T13:00:00Z',
        'updated_at', '2026-09-08T13:10:00Z',
        'items', jsonb_build_array(jsonb_build_object(
          'product_id', 'e2e-product',
          'sku', 'E2E-001',
          'name', 'Pedido sintetico de homologacao',
          'quantity', 1,
          'unit_price_cents', 5500,
          'line_total_cents', 5500,
          'modifiers', jsonb_build_array()
        ))
      ),
      'customer', jsonb_build_object(
        'athos_customer_id', 'e2e-customer',
        'name', 'Cliente Sintetico',
        'phone', '+5511999999999'
      ),
      'correlation', jsonb_build_object(
        'launch_id', c.launch_id,
        'crm_contact_id', c.contact_id,
        'crm_conversation_id', c.conversation_id
      )
    ) as payload
  from _athos_e2e_ctx c
), receipt as (
  insert into public.athos_sandbox_events (
    connection_id,
    event_id,
    event_type,
    occurred_at,
    store_ref,
    external_order_id,
    payload
  )
  select
    connection_id,
    status_event_id,
    'order.status_changed',
    '2026-09-08T13:10:00Z'::timestamptz,
    '5b7b4a38-4c54-488e-986f-9ea0428cff7a',
    external_order_id,
    payload
  from event_payload
  returning id
)
select count(*) as status_receipts from receipt;

with target_receipt as materialized (
  select e.id, e.connection_id, e.payload
  from public.athos_sandbox_events e
  join _athos_e2e_ctx c
    on c.connection_id = e.connection_id
   and c.status_event_id = e.event_id
), applied as materialized (
  select
    id,
    public.fn_apply_athos_sandbox_order_snapshot(connection_id, payload) as crm_order_id
  from target_receipt
)
update public.athos_sandbox_events e
set status = 'processed', processed_at = now(), error_message = null
from applied a
where e.id = a.id
  and a.crm_order_id is not null;

insert into _athos_e2e_assertions
select
  'status update keeps the same CRM order',
  o.id = c.canonical_order_id and o.food_status = 'preparing',
  o.id::text || ' / ' || o.food_status,
  c.canonical_order_id::text || ' / preparing'
from _athos_e2e_ctx c
join public.orders o
  on o.organization_id = c.organization_id
 and o.external_provider = 'deskcomm_food'
 and o.external_id = 'athos:' || c.external_order_id;

do $$
declare
  v_ctx _athos_e2e_ctx%rowtype;
begin
  select * into v_ctx from _athos_e2e_ctx;

  perform public.fn_apply_athos_sandbox_order_snapshot(
    v_ctx.connection_id,
    jsonb_build_object(
      'event_id', 'evt-delayed-' || gen_random_uuid()::text,
      'event_type', 'order.status_changed',
      'occurred_at', '2026-09-08T13:05:00Z',
      'store_ref', '5b7b4a38-4c54-488e-986f-9ea0428cff7a',
      'order', jsonb_build_object(
        'id', v_ctx.external_order_id,
        'status', 'cancelled',
        'total_cents', 5500,
        'currency', 'BRL',
        'created_at', '2026-09-08T13:00:00Z',
        'updated_at', '2026-09-08T13:05:00Z',
        'items', jsonb_build_array()
      ),
      'customer', jsonb_build_object('athos_customer_id', 'e2e-customer'),
      'correlation', jsonb_build_object(
        'launch_id', v_ctx.launch_id,
        'crm_contact_id', v_ctx.contact_id,
        'crm_conversation_id', v_ctx.conversation_id
      )
    )
  );
end;
$$;

insert into _athos_e2e_assertions
select
  'delayed event cannot regress status',
  o.food_status = 'preparing',
  o.food_status,
  'preparing'
from _athos_e2e_ctx c
join public.orders o
  on o.id = c.canonical_order_id;

insert into _athos_e2e_assertions
select
  'order preserves CRM correlation',
  o.contact_id = c.contact_id
    and o.payload #>> '{_integration,conversation_id}' = c.conversation_id::text
    and o.payload #>> '{_integration,source}' = 'athos',
  concat_ws(' / ', o.contact_id::text, o.payload #>> '{_integration,conversation_id}', o.payload #>> '{_integration,source}'),
  concat_ws(' / ', c.contact_id::text, c.conversation_id::text, 'athos')
from _athos_e2e_ctx c
join public.orders o
  on o.id = c.canonical_order_id;

insert into _athos_e2e_assertions
select
  'canonical order remains tenant isolated',
  count(*) = 0,
  count(*)::text,
  '0 rows outside the pilot tenant'
from public.orders o
join _athos_e2e_ctx c
  on o.external_provider = 'deskcomm_food'
 and o.external_id = 'athos:' || c.external_order_id
where o.organization_id <> c.organization_id;

insert into _athos_e2e_assertions
select
  'both receipts are processed',
  count(*) = 2 and bool_and(e.status = 'processed' and e.processed_at is not null),
  count(*)::text || ' receipts / ' || coalesce(string_agg(distinct e.status, ','), 'none'),
  '2 receipts / processed'
from public.athos_sandbox_events e
join _athos_e2e_ctx c
  on e.connection_id = c.connection_id
 and e.event_id in (c.created_event_id, c.status_event_id);

insert into _athos_e2e_assertions
select
  'binding is backend-only and RLS enabled',
  c.relrowsecurity
    and not has_table_privilege('anon', 'public.athos_sandbox_tenant_bindings', 'select')
    and not has_table_privilege('authenticated', 'public.athos_sandbox_tenant_bindings', 'select'),
  concat_ws(' / ', c.relrowsecurity::text,
    has_table_privilege('anon', 'public.athos_sandbox_tenant_bindings', 'select')::text,
    has_table_privilege('authenticated', 'public.athos_sandbox_tenant_bindings', 'select')::text),
  'true / false / false'
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'athos_sandbox_tenant_bindings';

do $$
begin
  begin
    perform public.fn_apply_athos_sandbox_order_snapshot(
      '1acdc3e8-488e-4539-90aa-869ed73de966',
      jsonb_build_object(
        'order', jsonb_build_object(
          'id', 'invalid-status-' || gen_random_uuid()::text,
          'status', 'unknown',
          'total_cents', 100,
          'updated_at', now()
        )
      )
    );
    insert into _athos_e2e_assertions values
      ('invalid status is rejected', false, 'accepted', 'SQLSTATE 22023');
  exception when sqlstate '22023' then
    insert into _athos_e2e_assertions values
      ('invalid status is rejected', true, 'SQLSTATE 22023', 'SQLSTATE 22023');
  end;

  begin
    perform public.fn_reconcile_athos_sandbox_order_to_crm(
      '1acdc3e8-488e-4539-90aa-869ed73de966',
      'ddf43755-46a0-4e0f-9739-c16d99d3a956'
    );
    insert into _athos_e2e_assertions values
      ('cross-tenant correlation is rejected', false, 'accepted', 'SQLSTATE 42501');
  exception when sqlstate '42501' then
    insert into _athos_e2e_assertions values
      ('cross-tenant correlation is rejected', true, 'SQLSTATE 42501', 'SQLSTATE 42501');
  end;
end;
$$;

do $$
declare
  v_failed text;
begin
  select string_agg(check_name || ' [observed: ' || coalesce(observed, 'null') || ']', ', ' order by check_name)
    into v_failed
  from _athos_e2e_assertions
  where passed = false;

  if v_failed is not null then
    raise exception using
      errcode = 'P0001',
      message = 'athos_crm_e2e_failed: ' || v_failed;
  end if;
end;
$$;

select check_name, passed, observed, expected
from _athos_e2e_assertions
order by check_name;

commit;

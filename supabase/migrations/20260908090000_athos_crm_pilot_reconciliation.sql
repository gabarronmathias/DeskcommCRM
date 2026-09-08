-- Athos pilot -> canonical CRM projection.
--
-- Keeps the already-homologated Athos HTTP contract untouched. The existing
-- athos_sandbox_* tables remain the immutable partner receipt/projection layer;
-- only explicitly bound sandbox connections are projected into tenant-scoped
-- CRM contacts/conversations/orders.

begin;

create unique index if not exists channel_sessions_id_org_uq
  on public.channel_sessions (id, organization_id);

create table if not exists public.athos_sandbox_tenant_bindings (
  connection_id uuid primary key
    references public.athos_sandbox_connections(id) on delete cascade,
  organization_id uuid not null unique
    references public.organizations(id) on delete cascade,
  channel_session_id uuid not null
    references public.channel_sessions(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint athos_sandbox_binding_session_org_fk
    foreign key (channel_session_id, organization_id)
    references public.channel_sessions(id, organization_id) on delete restrict
);

alter table public.athos_sandbox_tenant_bindings enable row level security;
revoke all on table public.athos_sandbox_tenant_bindings from public, anon, authenticated;
grant all on table public.athos_sandbox_tenant_bindings to service_role;

create or replace function public.fn_reconcile_athos_sandbox_order_to_crm(
  p_connection_id uuid,
  p_sandbox_order_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.athos_sandbox_orders%rowtype;
  v_organization_id uuid;
  v_channel_session_id uuid;
  v_launch_id uuid;
  v_contact_id uuid;
  v_conversation_id uuid;
  v_crm_order_id uuid;
  v_order_status text;
  v_food_status text;
  v_fulfillment_status text;
  v_payload jsonb;
begin
  select organization_id, channel_session_id
    into v_organization_id, v_channel_session_id
  from public.athos_sandbox_tenant_bindings
  where connection_id = p_connection_id
    and active = true;

  -- Unbound partner sandboxes keep their original isolated behavior.
  if v_organization_id is null then
    return null;
  end if;

  select *
    into v_order
  from public.athos_sandbox_orders
  where id = p_sandbox_order_id
    and connection_id = p_connection_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'athos_sandbox_order_not_found';
  end if;

  begin
    v_launch_id := nullif(v_order.correlation ->> 'launch_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'athos_invalid_launch_id';
  end;

  if v_launch_id is null then
    raise exception using errcode = '22023', message = 'athos_launch_required_for_crm_projection';
  end if;

  select l.crm_contact_id, l.crm_conversation_id
    into v_contact_id, v_conversation_id
  from public.athos_sandbox_launches l
  where l.launch_id = v_launch_id
    and l.connection_id = p_connection_id
    and l.store_ref = (
      select c.store_ref
      from public.athos_sandbox_connections c
      where c.id = p_connection_id
    );

  if v_contact_id is null then
    raise exception using errcode = 'P0002', message = 'athos_bound_launch_not_found';
  end if;

  if not exists (
    select 1 from public.contacts c
    where c.id = v_contact_id
      and c.organization_id = v_organization_id
      and c.is_anonymized = false
  ) then
    raise exception using errcode = '42501', message = 'athos_contact_outside_bound_tenant';
  end if;

  if v_conversation_id is null or not exists (
    select 1 from public.conversations c
    where c.id = v_conversation_id
      and c.organization_id = v_organization_id
      and c.contact_id = v_contact_id
      and c.channel_session_id = v_channel_session_id
  ) then
    raise exception using errcode = '42501', message = 'athos_conversation_outside_bound_tenant';
  end if;

  v_food_status := case v_order.athos_status
    when 'pending' then 'new'
    when 'confirmed' then 'accepted'
    when 'preparing' then 'preparing'
    when 'ready' then 'ready'
    when 'out_for_delivery' then 'out_for_delivery'
    when 'completed' then 'completed'
    when 'cancelled' then 'cancelled'
    else null
  end;

  if v_food_status is null then
    raise exception using errcode = '22023', message = 'athos_status_not_mappable';
  end if;

  v_order_status := case v_order.athos_status
    when 'completed' then 'fulfilled'
    when 'cancelled' then 'cancelled'
    else 'pending'
  end;

  v_fulfillment_status := case v_order.athos_status
    when 'completed' then 'delivered'
    when 'out_for_delivery' then 'shipped'
    when 'ready' then 'packed'
    else 'unpacked'
  end;

  v_payload := jsonb_set(
    v_order.payload,
    '{_integration}',
    jsonb_build_object(
      'source', 'athos',
      'environment', 'sandbox',
      'connection_id', p_connection_id,
      'sandbox_order_id', p_sandbox_order_id,
      'launch_id', v_launch_id,
      'conversation_id', v_conversation_id,
      'store_ref', (
        select c.store_ref
        from public.athos_sandbox_connections c
        where c.id = p_connection_id
      )
    ),
    true
  );

  insert into public.orders (
    organization_id,
    external_id,
    external_provider,
    customer_external_id,
    contact_id,
    status,
    total_cents,
    currency,
    fulfillment_status,
    payload,
    ordered_at,
    updated_at_remote,
    food_status,
    food_status_updated_at
  ) values (
    v_organization_id,
    'athos:' || v_order.external_order_id,
    'deskcomm_food',
    nullif(v_order.customer ->> 'athos_customer_id', ''),
    v_contact_id,
    v_order_status,
    v_order.total_cents,
    v_order.currency,
    v_fulfillment_status,
    v_payload,
    v_order.ordered_at,
    v_order.updated_at_remote,
    v_food_status,
    v_order.updated_at_remote
  )
  on conflict (organization_id, external_provider, external_id)
  do update set
    customer_external_id = excluded.customer_external_id,
    contact_id = excluded.contact_id,
    status = excluded.status,
    total_cents = excluded.total_cents,
    currency = excluded.currencx.excluded.currency,
    fulfillment_status = excluded.fulfillment_status,
    payload = excluded.payload,
    ordered_at = excluded.ordered_at,
    updated_at_remote = excluded.updated_at_remote,
    food_status = excluded.food_status,
    updated_at = now()
  where public.orders.updated_at_remote is null
     or excluded.updated_at_remote >= public.orders.updated_at_remote
  returning id into v_crm_order_id;

  if v_crm_order_id is null then
    select id into v_crm_order_id
    from public.orders
    where organization_id = v_organization_id
      and external_provider = 'deskcomm_food'
      and external_id = 'athos:' || v_order.external_order_id;
  end if;

  return v_crm_order_id;
end;
$$;

revoke all on function public.fn_reconcile_athos_sandbox_order_to_crm(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_reconcile_athos_sandbox_order_to_crm(uuid, uuid)
  to service_role;

create or replace function public.trg_reconcile_athos_sandbox_order_to_crm()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.fn_reconcile_athos_sandbox_order_to_crm(new.connection_id, new.id);
  return new;
end;
$$;

revoke all on function public.trg_reconcile_athos_sandbox_order_to_crm()
  from public, anon, authenticated;
grant execute on function public.trg_reconcile_athos_sandbox_order_to_crm()
  to service_role;

drop trigger if exists trg_athos_sandbox_order_to_crm
  on public.athos_sandbox_orders;
create trigger trg_athos_sandbox_order_to_crm
after insert or update of
  athos_status,
  total_cents,
  currency,
  customer,
  correlation,
  payload,
  ordered_at,
  updated_at_remote
on public.athos_sandbox_orders
for each row
execute function public.trg_reconcile_athos_sandbox_order_to_crm();

commit;

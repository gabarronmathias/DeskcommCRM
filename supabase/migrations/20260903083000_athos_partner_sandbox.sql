-- Athos partner sandbox (zero incremental infrastructure cost).
--
-- IMPORTANT: this migration deliberately does NOT alter or reference production
-- CRM business tables (organizations, contacts, conversations, orders, webhook logs).
-- All homologation data lives in athos_sandbox_* tables. RLS is enabled with no
-- user policies, so only service_role can access these rows through the app backend.

begin;

create table if not exists public.athos_sandbox_connections (
  id uuid primary key default gen_random_uuid(),
  environment text not null default 'sandbox' check (environment = 'sandbox'),
  store_ref text not null unique check (length(store_ref) between 1 and 160),
  menu_url text not null check (menu_url ~ '^https://'),
  bearer_hash text not null unique check (bearer_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] not null default array['partner:athos','athos:launch:read','athos:events:write']::text[],
  active boolean not null default true,
  bearer_expires_at timestamptz not null default (now() + interval '90 days'),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.athos_sandbox_launches (
  launch_id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.athos_sandbox_connections(id) on delete cascade,
  store_ref text not null,
  crm_contact_id uuid not null,
  crm_conversation_id uuid,
  customer_display_name text,
  customer_phone text,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  created_at timestamptz not null default now()
);

create index if not exists athos_sandbox_launches_connection_idx
  on public.athos_sandbox_launches (connection_id, created_at desc);

create table if not exists public.athos_sandbox_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.athos_sandbox_connections(id) on delete cascade,
  event_id text not null check (length(event_id) between 1 and 200),
  event_type text not null check (event_type in ('order.created','order.updated','order.status_changed','order.completed','order.cancelled')),
  occurred_at timestamptz not null,
  store_ref text not null,
  external_order_id text not null check (length(external_order_id) between 1 and 200),
  payload jsonb not null,
  status text not null default 'received' check (status in ('received','processed','error')),
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (connection_id, event_id)
);

create index if not exists athos_sandbox_events_rate_idx
  on public.athos_sandbox_events (connection_id, received_at desc);
create index if not exists athos_sandbox_events_order_idx
  on public.athos_sandbox_events (connection_id, external_order_id, occurred_at desc);

create table if not exists public.athos_sandbox_orders (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.athos_sandbox_connections(id) on delete cascade,
  external_order_id text not null,
  athos_status text not null,
  total_cents bigint not null check (total_cents >= 0),
  currency char(3) not null default 'BRL',
  customer jsonb not null default '{}'::jsonb,
  correlation jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  ordered_at timestamptz not null,
  updated_at_remote timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, external_order_id)
);

create table if not exists public.athos_sandbox_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.athos_sandbox_orders(id) on delete cascade,
  product_ref text,
  sku text,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  line_total_cents bigint not null check (line_total_cents >= 0),
  modifiers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.athos_sandbox_connections enable row level security;
alter table public.athos_sandbox_launches enable row level security;
alter table public.athos_sandbox_events enable row level security;
alter table public.athos_sandbox_orders enable row level security;
alter table public.athos_sandbox_order_items enable row level security;

-- No authenticated/anon policies on purpose. These tables are backend-only.
revoke all on table public.athos_sandbox_connections from anon, authenticated;
revoke all on table public.athos_sandbox_launches from anon, authenticated;
revoke all on table public.athos_sandbox_events from anon, authenticated;
revoke all on table public.athos_sandbox_orders from anon, authenticated;
revoke all on table public.athos_sandbox_order_items from anon, authenticated;

grant all on table public.athos_sandbox_connections to service_role;
grant all on table public.athos_sandbox_launches to service_role;
grant all on table public.athos_sandbox_events to service_role;
grant all on table public.athos_sandbox_orders to service_role;
grant all on table public.athos_sandbox_order_items to service_role;

-- Atomically project an Athos event into sandbox-only order tables.
create or replace function public.fn_apply_athos_sandbox_order_snapshot(
  p_connection_id uuid,
  p_event jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order jsonb := p_event -> 'order';
  v_external_id text := v_order ->> 'id';
  v_status text := v_order ->> 'status';
  v_order_id uuid;
  v_existing_remote timestamptz;
  v_remote_updated timestamptz;
  v_item jsonb;
begin
  if p_connection_id is null or v_order is null or v_external_id is null then
    raise exception using errcode = '22023', message = 'invalid_athos_sandbox_snapshot';
  end if;

  if v_status not in ('pending','confirmed','preparing','ready','out_for_delivery','completed','cancelled') then
    raise exception using errcode = '22023', message = 'invalid_athos_order_status';
  end if;

  if not exists (
    select 1 from public.athos_sandbox_connections
    where id = p_connection_id and active = true and revoked_at is null
  ) then
    raise exception using errcode = '42501', message = 'athos_sandbox_connection_inactive';
  end if;

  v_remote_updated := coalesce(
    nullif(v_order ->> 'updated_at', '')::timestamptz,
    nullif(p_event ->> 'occurred_at', '')::timestamptz,
    now()
  );

  select id, updated_at_remote
    into v_order_id, v_existing_remote
  from public.athos_sandbox_orders
  where connection_id = p_connection_id
    and external_order_id = v_external_id
  for update;

  -- Keep delayed retries for the event receipt, but never regress the order snapshot.
  if v_order_id is not null and v_existing_remote is not null and v_remote_updated < v_existing_remote then
    return v_order_id;
  end if;

  if v_order_id is null then
    insert into public.athos_sandbox_orders (
      connection_id, external_order_id, athos_status, total_cents, currency,
      customer, correlation, payload, ordered_at, updated_at_remote
    ) values (
      p_connection_id,
      v_external_id,
      v_status,
      (v_order ->> 'total_cents')::bigint,
      upper(coalesce(nullif(v_order ->> 'currency', ''), 'BRL'))::char(3),
      coalesce(p_event -> 'customer', '{}'::jsonb),
      coalesce(p_event -> 'correlation', '{}'::jsonb),
      p_event,
      coalesce(nullif(v_order ->> 'created_at', '')::timestamptz, v_remote_updated),
      v_remote_updated
    ) returning id into v_order_id;
  else
    update public.athos_sandbox_orders
    set athos_status = v_status,
        total_cents = (v_order ->> 'total_cents')::bigint,
        currency = upper(coalesce(nullif(v_order ->> 'currency', ''), 'BRL'))::char(3),
        customer = coalesce(p_event -> 'customer', '{}'::jsonb),
        correlation = coalesce(p_event -> 'correlation', '{}'::jsonb),
        payload = p_event,
        updated_at_remote = v_remote_updated,
        updated_at = now()
    where id = v_order_id;
  end if;

  delete from public.athos_sandbox_order_items where order_id = v_order_id;
  for v_item in select value from jsonb_array_elements(coalesce(v_order -> 'items', '[]'::jsonb))
  loop
    insert into public.athos_sandbox_order_items (
      order_id, product_ref, sku, product_name, quantity,
      unit_price_cents, line_total_cents, modifiers
    ) values (
      v_order_id,
      nullif(v_item ->> 'product_id', ''),
      nullif(v_item ->> 'sku', ''),
      coalesce(nullif(v_item ->> 'name', ''), 'Item Athos Sandbox'),
      (v_item ->> 'quantity')::integer,
      (v_item ->> 'unit_price_cents')::bigint,
      (v_item ->> 'line_total_cents')::bigint,
      coalesce(v_item -> 'modifiers', '[]'::jsonb)
    );
  end loop;

  return v_order_id;
end;
$$;

revoke all on function public.fn_apply_athos_sandbox_order_snapshot(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_apply_athos_sandbox_order_snapshot(uuid, jsonb) to service_role;

commit;

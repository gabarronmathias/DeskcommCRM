-- Athos partner sandbox: isolated credentials, launch correlation and idempotent events.
-- Secrets are never stored in plaintext. Bearers are SHA-256 hashes and HMAC
-- secrets use the same encrypted-at-rest primitive already used by integrations.

begin;

-- Existing canonical order/webhook tables must recognize Athos as a provider.
alter table public.orders
  drop constraint if exists orders_external_provider_check;
alter table public.orders
  add constraint orders_external_provider_check
  check (external_provider = any (array['nuvemshop','vtex','shopify','deskcomm_food','athos']::text[]));

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;
alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check
  check (provider = any (array['waha','nuvemshop','generic','meta_cloud','zernio','athos']::text[]));

create table if not exists public.partner_athos_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  environment text not null default 'sandbox' check (environment in ('sandbox','production')),
  store_ref text not null check (length(store_ref) between 1 and 160),
  menu_url text not null check (menu_url ~ '^https://'),
  bearer_hash text not null check (bearer_hash ~ '^[a-f0-9]{64}$'),
  hmac_secret_encrypted bytea not null,
  scopes text[] not null default array['partner:athos','athos:launch:read','athos:events:write']::text[],
  active boolean not null default true,
  bearer_expires_at timestamptz not null default (now() + interval '90 days'),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, environment, store_ref)
);

create unique index if not exists partner_athos_connections_bearer_hash_uidx
  on public.partner_athos_connections (bearer_hash);

create table if not exists public.partner_athos_launches (
  launch_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.partner_athos_connections(id) on delete cascade,
  store_ref text not null check (length(store_ref) between 1 and 160),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  created_at timestamptz not null default now()
);

create index if not exists partner_athos_launches_connection_idx
  on public.partner_athos_launches (connection_id, created_at desc);
create index if not exists partner_athos_launches_contact_idx
  on public.partner_athos_launches (organization_id, contact_id, created_at desc);

create table if not exists public.partner_athos_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.partner_athos_connections(id) on delete cascade,
  event_id text not null check (length(event_id) between 1 and 200),
  event_type text not null check (event_type in ('order.created','order.updated','order.status_changed','order.completed','order.cancelled')),
  occurred_at timestamptz not null,
  store_ref text not null check (length(store_ref) between 1 and 160),
  external_order_id text not null check (length(external_order_id) between 1 and 200),
  payload jsonb not null,
  status text not null default 'received' check (status in ('received','processed','error')),
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (connection_id, event_id)
);

create index if not exists partner_athos_events_rate_idx
  on public.partner_athos_events (connection_id, received_at desc);
create index if not exists partner_athos_events_order_idx
  on public.partner_athos_events (organization_id, external_order_id, occurred_at desc);

alter table public.partner_athos_connections enable row level security;
alter table public.partner_athos_launches enable row level security;
alter table public.partner_athos_events enable row level security;

-- Connection configuration is visible to the tenant; only manager+ may mutate it.
drop policy if exists partner_athos_connections_select on public.partner_athos_connections;
create policy partner_athos_connections_select
  on public.partner_athos_connections for select
  using ((organization_id in (select fn_user_org_ids())) or fn_is_platform_admin());

drop policy if exists partner_athos_connections_admin_write on public.partner_athos_connections;
create policy partner_athos_connections_admin_write
  on public.partner_athos_connections for all
  using (fn_is_platform_admin() or ((organization_id in (select fn_user_org_ids())) and fn_role_at_least(organization_id, 'manager')))
  with check (fn_is_platform_admin() or ((organization_id in (select fn_user_org_ids())) and fn_role_at_least(organization_id, 'manager')));

-- Launches and event receipts contain relationship/order context. Tenant isolation is mandatory.
drop policy if exists partner_athos_launches_tenant_all on public.partner_athos_launches;
create policy partner_athos_launches_tenant_all
  on public.partner_athos_launches for all
  using ((organization_id in (select fn_user_org_ids())) or fn_is_platform_admin())
  with check ((organization_id in (select fn_user_org_ids())) or fn_is_platform_admin());

drop policy if exists partner_athos_events_tenant_select on public.partner_athos_events;
create policy partner_athos_events_tenant_select
  on public.partner_athos_events for select
  using ((organization_id in (select fn_user_org_ids())) or fn_is_platform_admin());

-- Apply an authenticated Athos order snapshot atomically to the canonical CRM order model.
create or replace function public.fn_apply_athos_order_snapshot(
  p_organization_id uuid,
  p_contact_id uuid,
  p_event jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order jsonb := p_event -> 'order';
  v_external_id text := v_order ->> 'id';
  v_athos_status text := v_order ->> 'status';
  v_food_status text;
  v_order_status text;
  v_order_id uuid;
  v_old_food_status text;
  v_existing_remote timestamptz;
  v_remote_updated timestamptz;
  v_item jsonb;
begin
  if p_organization_id is null or v_order is null or v_external_id is null then
    raise exception using errcode = '22023', message = 'invalid_athos_order_snapshot';
  end if;

  v_food_status := case v_athos_status
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
    raise exception using errcode = '22023', message = 'invalid_athos_order_status';
  end if;

  v_order_status := case
    when v_athos_status = 'cancelled' then 'cancelled'
    when v_athos_status = 'completed' then 'fulfilled'
    when v_athos_status = 'out_for_delivery' then 'shipped'
    else 'pending'
  end;

  v_remote_updated := coalesce(
    nullif(v_order ->> 'updated_at', '')::timestamptz,
    nullif(p_event ->> 'occurred_at', '')::timestamptz,
    now()
  );

  select id, food_status, updated_at_remote
    into v_order_id, v_old_food_status, v_existing_remote
  from public.orders
  where organization_id = p_organization_id
    and external_provider = 'athos'
    and external_id = v_external_id
  for update;

  -- Accept delayed events for audit/idempotency, but never regress the current snapshot.
  if v_order_id is not null and v_existing_remote is not null and v_remote_updated < v_existing_remote then
    return v_order_id;
  end if;

  if v_order_id is null then
    insert into public.orders (
      organization_id, external_id, external_provider, customer_external_id,
      contact_id, status, total_cents, currency, payload, ordered_at,
      updated_at_remote, food_status, food_status_updated_at
    ) values (
      p_organization_id,
      v_external_id,
      'athos',
      nullif(p_event #>> '{customer,athos_customer_id}', ''),
      p_contact_id,
      v_order_status,
      (v_order ->> 'total_cents')::bigint,
      upper(coalesce(nullif(v_order ->> 'currency', ''), 'BRL'))::char(3),
      p_event,
      coalesce(nullif(v_order ->> 'created_at', '')::timestamptz, v_remote_updated),
      v_remote_updated,
      v_food_status,
      v_remote_updated
    ) returning id into v_order_id;
  else
    update public.orders
    set customer_external_id = coalesce(nullif(p_event #>> '{customer,athos_customer_id}', ''), customer_external_id),
        contact_id = coalesce(p_contact_id, contact_id),
        status = v_order_status,
        total_cents = (v_order ->> 'total_cents')::bigint,
        currency = upper(coalesce(nullif(v_order ->> 'currency', ''), 'BRL'))::char(3),
        payload = p_event,
        updated_at_remote = v_remote_updated,
        food_status = v_food_status,
        food_status_updated_at = case when food_status is distinct from v_food_status then v_remote_updated else food_status_updated_at end,
        updated_at = now()
    where id = v_order_id;
  end if;

  -- Snapshot semantics: Athos is the operational source of truth, so replace item rows.
  delete from public.food_order_items where order_id = v_order_id;
  for v_item in select value from jsonb_array_elements(coalesce(v_order -> 'items', '[]'::jsonb))
  loop
    insert into public.food_order_items (
      organization_id, order_id, product_id, product_name_snapshot,
      unit_price_cents, quantity, line_total_cents, selected_modifiers,
      added_via_recommendation
    ) values (
      p_organization_id,
      v_order_id,
      null,
      coalesce(nullif(v_item ->> 'name', ''), 'Item Athos'),
      (v_item ->> 'unit_price_cents')::bigint,
      (v_item ->> 'quantity')::integer,
      (v_item ->> 'line_total_cents')::bigint,
      coalesce(v_item -> 'modifiers', '[]'::jsonb),
      false
    );
  end loop;

  if v_old_food_status is distinct from v_food_status then
    insert into public.food_order_status_history (
      organization_id, order_id, from_status, to_status, note
    ) values (
      p_organization_id, v_order_id, v_old_food_status, v_food_status, 'Sincronizado pela Athos'
    );
  end if;

  return v_order_id;
end;
$$;

revoke all on function public.fn_apply_athos_order_snapshot(uuid, uuid, jsonb) from public;
grant execute on function public.fn_apply_athos_order_snapshot(uuid, uuid, jsonb) to service_role;

commit;

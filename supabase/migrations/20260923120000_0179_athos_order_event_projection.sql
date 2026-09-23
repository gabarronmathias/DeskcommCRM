-- Atomically mirrors Athos sandbox order events into the CRM order list.
-- Uses the existing tenant/provider/external-id unique key for replay safety.
alter table public.tenant_integrations
  add column if not exists partner_api_token_id uuid references public.api_tokens(id) on delete set null;
alter table public.orders
  add column if not exists athos_event_id text;
alter table public.food_order_items
  add column if not exists external_product_id text,
  add column if not exists external_sku text;

create table if not exists public.partner_launches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null default 'athos' check (provider = 'athos'),
  contact_id uuid not null,
  conversation_id uuid,
  store_ref text not null,
  created_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  accessed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint partner_launches_contact_org_fk foreign key (contact_id, organization_id)
    references public.contacts(id, organization_id) on delete cascade,
  constraint partner_launches_conversation_org_fk foreign key (conversation_id, organization_id)
    references public.conversations(id, organization_id) on delete restrict,
  constraint partner_launches_expiry_check check (expires_at > created_at)
);
create index if not exists partner_launches_org_provider_idx
  on public.partner_launches (organization_id, provider, created_at desc);
alter table public.partner_launches enable row level security;
revoke all on public.partner_launches from anon, authenticated;
grant all on public.partner_launches to service_role;

create or replace function public.fn_apply_athos_order_event(
  p_organization_id uuid,
  p_contact_id uuid,
  p_conversation_id uuid,
  p_event jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order jsonb := p_event -> 'order';
  v_external_id text := v_order ->> 'id';
  v_event_id text := p_event ->> 'event_id';
  v_status text := v_order ->> 'status';
  v_remote_updated timestamptz := coalesce(nullif(v_order ->> 'updated_at', '')::timestamptz, nullif(p_event ->> 'occurred_at', '')::timestamptz, now());
  v_ordered_at timestamptz := coalesce(nullif(v_order ->> 'created_at', '')::timestamptz, v_remote_updated);
  v_crm_status text;
  v_order_id uuid;
  v_applied boolean;
  v_existing_event_id text;
  v_item jsonb;
begin
  if p_organization_id is null or p_contact_id is null or v_external_id is null or v_event_id is null then
    raise exception using errcode = '22023', message = 'invalid_athos_order_event';
  end if;
  if not exists (select 1 from contacts where id = p_contact_id and organization_id = p_organization_id) then
    raise exception using errcode = '23503', message = 'athos_contact_not_in_tenant';
  end if;
  if p_conversation_id is not null and not exists (
    select 1 from conversations where id = p_conversation_id and organization_id = p_organization_id
  ) then
    raise exception using errcode = '23503', message = 'athos_conversation_not_in_tenant';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':athos:' || v_external_id, 0));
  select id, athos_event_id into v_order_id, v_existing_event_id
  from orders
  where organization_id = p_organization_id and external_provider = 'athos' and external_id = v_external_id
  for update;
  if v_order_id is not null and v_existing_event_id = v_event_id then
    return jsonb_build_object('order_id', v_order_id, 'duplicate', true);
  end if;
  v_order_id := null;
  v_crm_status := case v_status when 'cancelled' then 'cancelled' when 'completed' then 'fulfilled' else 'pending' end;

  insert into orders (
    organization_id, external_id, external_provider, customer_external_id, contact_id,
    status, total_cents, currency, payload, ordered_at, updated_at_remote, athos_event_id
  ) values (
    p_organization_id, v_external_id, 'athos', nullif(p_event #>> '{customer,athos_customer_id}', ''), p_contact_id,
    v_crm_status, (v_order ->> 'total_cents')::bigint,
    upper(coalesce(nullif(v_order ->> 'currency', ''), 'BRL')),
    jsonb_build_object('source','athos','athos_status',v_status,'event',p_event,'correlation',p_event -> 'correlation'),
    v_ordered_at, v_remote_updated, v_event_id
  )
  on conflict (organization_id, external_provider, external_id) do update set
    customer_external_id = excluded.customer_external_id,
    contact_id = excluded.contact_id,
    status = excluded.status,
    total_cents = excluded.total_cents,
    currency = excluded.currency,
    payload = excluded.payload,
    updated_at_remote = excluded.updated_at_remote,
    athos_event_id = excluded.athos_event_id,
    updated_at = now()
  where orders.updated_at_remote is null or excluded.updated_at_remote >= orders.updated_at_remote
  returning id into v_order_id;

  v_applied := v_order_id is not null;
  if not v_applied then
    select id into v_order_id from orders
    where organization_id = p_organization_id and external_provider = 'athos' and external_id = v_external_id;
  else
    delete from food_order_items where organization_id = p_organization_id and order_id = v_order_id;
    for v_item in select value from jsonb_array_elements(v_order -> 'items') loop
      insert into food_order_items (
        organization_id, order_id, product_id, external_product_id, external_sku,
        product_name_snapshot, unit_price_cents, quantity, line_total_cents, selected_modifiers
      ) values (
        p_organization_id, v_order_id, null, v_item ->> 'product_id', v_item ->> 'sku',
        v_item ->> 'name', (v_item ->> 'unit_price_cents')::bigint,
        (v_item ->> 'quantity')::integer, (v_item ->> 'line_total_cents')::bigint,
        coalesce(v_item -> 'modifiers', '[]'::jsonb)
      );
    end loop;
  end if;
  return jsonb_build_object('order_id', v_order_id, 'duplicate', not v_applied);
end;
$$;

revoke all on function public.fn_apply_athos_order_event(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_apply_athos_order_event(uuid, uuid, uuid, jsonb) to service_role;

-- 0158_food_commerce
-- Food Commerce multi-tenant para DeskcommCRM.
-- Genérico: não contém marca, produto ou tenant específico.
-- Requer as migrations anteriores do DeskcommCRM (organizations, contacts,
-- orders, idempotency_keys, emit_event, fn_touch_updated_at, fn_role_at_least).

alter table public.orders
  drop constraint if exists orders_external_provider_check;

alter table public.orders
  add constraint orders_external_provider_check
  check (external_provider = any (array[
    'nuvemshop'::text,
    'vtex'::text,
    'shopify'::text,
    'deskcomm_food'::text
  ]));

create unique index if not exists orders_id_org_uq
  on public.orders (id, organization_id);

create table if not exists public.food_commerce_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  app_name text not null,
  logo_url text,
  accent_hex text not null default '#6B5F33'
    check (accent_hex ~ '^#[0-9A-Fa-f]{6}$'),
  accent_soft_hex text not null default '#EFE7D5'
    check (accent_soft_hex ~ '^#[0-9A-Fa-f]{6}$'),
  tagline text,
  headline text,
  description text,
  whatsapp_number text,
  free_shipping_threshold_cents bigint
    check (free_shipping_threshold_cents is null or free_shipping_threshold_cents >= 0),
  currency char(3) not null default 'BRL',
  is_enabled boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.food_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug),
  unique (id, organization_id)
);

create table if not exists public.food_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  category_id uuid,
  name text not null,
  slug text not null,
  description text,
  image_url text,
  emoji text,
  price_cents bigint not null check (price_cents >= 0),
  compare_at_price_cents bigint
    check (compare_at_price_cents is null or compare_at_price_cents >= price_cents),
  is_available boolean not null default true,
  sort_order integer not null default 0,
  sku text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug),
  unique (id, organization_id)
);

create table if not exists public.food_modifier_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null,
  name text not null,
  min_select integer not null default 0 check (min_select >= 0),
  max_select integer not null default 1 check (max_select >= 1 and max_select >= min_select),
  is_required boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);

create table if not exists public.food_modifiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  group_id uuid not null,
  name text not null,
  price_delta_cents bigint not null default 0,
  sort_order integer not null default 0,
  is_available boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);

create table if not exists public.food_recommendation_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null
    check (kind in ('upsell','cross_sell','upgrade','combo','order_bump','cart_goal')),
  name text not null,
  trigger_product_id uuid,
  recommended_product_id uuid,
  threshold_cents bigint check (threshold_cents is null or threshold_cents >= 0),
  priority integer not null default 100,
  is_active boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint food_recommendation_target_check
    check (
      (kind = 'cart_goal' and recommended_product_id is null)
      or (kind <> 'cart_goal' and recommended_product_id is not null)
    )
);

create table if not exists public.food_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null,
  product_id uuid,
  product_name_snapshot text not null,
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  quantity integer not null check (quantity > 0),
  line_total_cents bigint not null check (line_total_cents >= 0),
  selected_modifiers jsonb not null default '[]'::jsonb,
  added_via_recommendation boolean not null default false,
  recommendation_rule_id uuid references public.food_recommendation_rules(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.food_recommendation_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  session_key text not null,
  event_key text,
  rule_id uuid references public.food_recommendation_rules(id) on delete set null,
  trigger_product_id uuid references public.food_products(id) on delete set null,
  recommended_product_id uuid references public.food_products(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  event_type text not null check (event_type in ('shown','clicked','added','removed','purchased')),
  attributed_revenue_cents bigint not null default 0 check (attributed_revenue_cents >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.food_recommendation_events
  add column if not exists event_key text;

-- FKs compostas impedem cruzamento acidental de tenant.
alter table public.food_products drop constraint if exists food_products_category_org_fk;
alter table public.food_products
  add constraint food_products_category_org_fk
  foreign key (category_id, organization_id)
  references public.food_categories(id, organization_id)
  on delete restrict;

alter table public.food_modifier_groups drop constraint if exists food_modifier_groups_product_org_fk;
alter table public.food_modifier_groups
  add constraint food_modifier_groups_product_org_fk
  foreign key (product_id, organization_id)
  references public.food_products(id, organization_id)
  on delete cascade;

alter table public.food_modifiers drop constraint if exists food_modifiers_group_org_fk;
alter table public.food_modifiers
  add constraint food_modifiers_group_org_fk
  foreign key (group_id, organization_id)
  references public.food_modifier_groups(id, organization_id)
  on delete cascade;

alter table public.food_recommendation_rules drop constraint if exists food_recommendation_trigger_org_fk;
alter table public.food_recommendation_rules
  add constraint food_recommendation_trigger_org_fk
  foreign key (trigger_product_id, organization_id)
  references public.food_products(id, organization_id)
  on delete cascade;

alter table public.food_recommendation_rules drop constraint if exists food_recommendation_product_org_fk;
alter table public.food_recommendation_rules
  add constraint food_recommendation_product_org_fk
  foreign key (recommended_product_id, organization_id)
  references public.food_products(id, organization_id)
  on delete cascade;

alter table public.food_order_items drop constraint if exists food_order_items_order_org_fk;
alter table public.food_order_items
  add constraint food_order_items_order_org_fk
  foreign key (order_id, organization_id)
  references public.orders(id, organization_id)
  on delete cascade;

alter table public.food_order_items drop constraint if exists food_order_items_product_org_fk;
alter table public.food_order_items
  add constraint food_order_items_product_org_fk
  foreign key (product_id, organization_id)
  references public.food_products(id, organization_id)
  on delete restrict;

create index if not exists food_categories_org_active_idx
  on public.food_categories (organization_id, is_active, sort_order);
create index if not exists food_products_org_available_idx
  on public.food_products (organization_id, is_available, sort_order);
create index if not exists food_products_category_idx
  on public.food_products (organization_id, category_id, sort_order);
create index if not exists food_modifier_groups_product_idx
  on public.food_modifier_groups (organization_id, product_id, sort_order);
create index if not exists food_modifiers_group_idx
  on public.food_modifiers (organization_id, group_id, sort_order);
create index if not exists food_recommendation_rules_org_idx
  on public.food_recommendation_rules (organization_id, is_active, priority);
create index if not exists food_order_items_order_idx
  on public.food_order_items (organization_id, order_id);
create index if not exists food_recommendation_events_session_idx
  on public.food_recommendation_events (organization_id, session_key, created_at);
create index if not exists food_recommendation_events_order_idx
  on public.food_recommendation_events (organization_id, order_id)
  where order_id is not null;
create index if not exists food_order_items_recommendation_rule_idx
  on public.food_order_items(recommendation_rule_id);
create index if not exists food_recommendation_events_rule_idx
  on public.food_recommendation_events(rule_id);
create index if not exists food_recommendation_events_trigger_product_idx
  on public.food_recommendation_events(trigger_product_id);
create index if not exists food_recommendation_events_recommended_product_idx
  on public.food_recommendation_events(recommended_product_id);
create index if not exists food_recommendation_events_order_id_idx
  on public.food_recommendation_events(order_id);
create unique index if not exists food_recommendation_events_event_key_uq
  on public.food_recommendation_events(organization_id, event_key)
  where event_key is not null;

-- updated_at
DO $$
BEGIN
  DROP TRIGGER IF EXISTS food_commerce_settings_touch_updated_at ON public.food_commerce_settings;
  CREATE TRIGGER food_commerce_settings_touch_updated_at
    BEFORE UPDATE ON public.food_commerce_settings
    FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

  DROP TRIGGER IF EXISTS food_categories_touch_updated_at ON public.food_categories;
  CREATE TRIGGER food_categories_touch_updated_at
    BEFORE UPDATE ON public.food_categories
    FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

  DROP TRIGGER IF EXISTS food_products_touch_updated_at ON public.food_products;
  CREATE TRIGGER food_products_touch_updated_at
    BEFORE UPDATE ON public.food_products
    FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

  DROP TRIGGER IF EXISTS food_modifier_groups_touch_updated_at ON public.food_modifier_groups;
  CREATE TRIGGER food_modifier_groups_touch_updated_at
    BEFORE UPDATE ON public.food_modifier_groups
    FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

  DROP TRIGGER IF EXISTS food_modifiers_touch_updated_at ON public.food_modifiers;
  CREATE TRIGGER food_modifiers_touch_updated_at
    BEFORE UPDATE ON public.food_modifiers
    FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

  DROP TRIGGER IF EXISTS food_recommendation_rules_touch_updated_at ON public.food_recommendation_rules;
  CREATE TRIGGER food_recommendation_rules_touch_updated_at
    BEFORE UPDATE ON public.food_recommendation_rules
    FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();
END $$;

-- RLS: leitura a viewer; configuração exige manager; pedido/evento só backend.
alter table public.food_commerce_settings enable row level security;
alter table public.food_categories enable row level security;
alter table public.food_products enable row level security;
alter table public.food_modifier_groups enable row level security;
alter table public.food_modifiers enable row level security;
alter table public.food_recommendation_rules enable row level security;
alter table public.food_order_items enable row level security;
alter table public.food_recommendation_events enable row level security;

-- remove policies da primeira versão experimental, se existirem
DROP POLICY IF EXISTS food_commerce_settings_tenant_all ON public.food_commerce_settings;
DROP POLICY IF EXISTS food_categories_tenant_all ON public.food_categories;
DROP POLICY IF EXISTS food_products_tenant_all ON public.food_products;
DROP POLICY IF EXISTS food_modifier_groups_tenant_all ON public.food_modifier_groups;
DROP POLICY IF EXISTS food_modifiers_tenant_all ON public.food_modifiers;
DROP POLICY IF EXISTS food_recommendation_rules_tenant_all ON public.food_recommendation_rules;
DROP POLICY IF EXISTS food_order_items_tenant_all ON public.food_order_items;
DROP POLICY IF EXISTS food_recommendation_events_tenant_all ON public.food_recommendation_events;

DROP POLICY IF EXISTS food_commerce_settings_select ON public.food_commerce_settings;
CREATE POLICY food_commerce_settings_select ON public.food_commerce_settings
FOR SELECT TO authenticated
USING (public.fn_role_at_least(organization_id, 'viewer') OR public.fn_is_platform_admin());
DROP POLICY IF EXISTS food_commerce_settings_write ON public.food_commerce_settings;
CREATE POLICY food_commerce_settings_write ON public.food_commerce_settings
FOR ALL TO authenticated
USING (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin())
WITH CHECK (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin());

DROP POLICY IF EXISTS food_categories_select ON public.food_categories;
CREATE POLICY food_categories_select ON public.food_categories
FOR SELECT TO authenticated
USING (public.fn_role_at_least(organization_id, 'viewer') OR public.fn_is_platform_admin());
DROP POLICY IF EXISTS food_categories_write ON public.food_categories;
CREATE POLICY food_categories_write ON public.food_categories
FOR ALL TO authenticated
USING (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin())
WITH CHECK (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin());

DROP POLICY IF EXISTS food_products_select ON public.food_products;
CREATE POLICY food_products_select ON public.food_products
FOR SELECT TO authenticated
USING (public.fn_role_at_least(organization_id, 'viewer') OR public.fn_is_platform_admin());
DROP POLICY IF EXISTS food_products_write ON public.food_products;
CREATE POLICY food_products_write ON public.food_products
FOR ALL TO authenticated
USING (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin())
WITH CHECK (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin());

DROP POLICY IF EXISTS food_modifier_groups_select ON public.food_modifier_groups;
CREATE POLICY food_modifier_groups_select ON public.food_modifier_groups
FOR SELECT TO authenticated
USING (public.fn_role_at_least(organization_id, 'viewer') OR public.fn_is_platform_admin());
DROP POLICY IF EXISTS food_modifier_groups_write ON public.food_modifier_groups;
CREATE POLICY food_modifier_groups_write ON public.food_modifier_groups
FOR ALL TO authenticated
USING (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin())
WITH CHECK (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin());

DROP POLICY IF EXISTS food_modifiers_select ON public.food_modifiers;
CREATE POLICY food_modifiers_select ON public.food_modifiers
FOR SELECT TO authenticated
USING (public.fn_role_at_least(organization_id, 'viewer') OR public.fn_is_platform_admin());
DROP POLICY IF EXISTS food_modifiers_write ON public.food_modifiers;
CREATE POLICY food_modifiers_write ON public.food_modifiers
FOR ALL TO authenticated
USING (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin())
WITH CHECK (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin());

DROP POLICY IF EXISTS food_recommendation_rules_select ON public.food_recommendation_rules;
CREATE POLICY food_recommendation_rules_select ON public.food_recommendation_rules
FOR SELECT TO authenticated
USING (public.fn_role_at_least(organization_id, 'viewer') OR public.fn_is_platform_admin());
DROP POLICY IF EXISTS food_recommendation_rules_write ON public.food_recommendation_rules;
CREATE POLICY food_recommendation_rules_write ON public.food_recommendation_rules
FOR ALL TO authenticated
USING (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin())
WITH CHECK (public.fn_role_at_least(organization_id, 'manager') OR public.fn_is_platform_admin());

DROP POLICY IF EXISTS food_order_items_select ON public.food_order_items;
CREATE POLICY food_order_items_select ON public.food_order_items
FOR SELECT TO authenticated
USING (public.fn_role_at_least(organization_id, 'viewer') OR public.fn_is_platform_admin());

DROP POLICY IF EXISTS food_recommendation_events_select ON public.food_recommendation_events;
CREATE POLICY food_recommendation_events_select ON public.food_recommendation_events
FOR SELECT TO authenticated
USING (public.fn_role_at_least(organization_id, 'viewer') OR public.fn_is_platform_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.food_commerce_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.food_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.food_products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.food_modifier_groups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.food_modifiers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.food_recommendation_rules TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.food_order_items FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.food_recommendation_events FROM authenticated;
GRANT SELECT ON public.food_order_items TO authenticated;
GRANT SELECT ON public.food_recommendation_events TO authenticated;

create or replace function public.fn_food_normalize_phone(p_phone text)
returns text
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_digits text;
begin
  v_digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if v_digits = '' then
    raise exception 'phone_required' using errcode = '22023';
  end if;
  if length(v_digits) in (10, 11) then
    v_digits := '55' || v_digits;
  end if;
  if length(v_digits) < 8 or length(v_digits) > 15 then
    raise exception 'phone_invalid' using errcode = '22023';
  end if;
  return '+' || v_digits;
end;
$$;
REVOKE EXECUTE ON FUNCTION public.fn_food_normalize_phone(text) FROM PUBLIC, anon, authenticated;

create or replace function public.fn_food_public_catalog(p_tenant_slug text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_org record;
  v_result jsonb;
begin
  select o.id, o.slug::text as slug, o.display_name,
         s.app_name, s.logo_url, s.accent_hex, s.accent_soft_hex,
         s.tagline, s.headline, s.description, s.whatsapp_number,
         s.free_shipping_threshold_cents, s.currency
    into v_org
  from public.organizations o
  join public.food_commerce_settings s on s.organization_id = o.id
  where o.slug::text = lower(trim(p_tenant_slug))
    and o.status = 'active'
    and s.is_enabled = true;

  if not found then
    raise exception 'food_tenant_not_found' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'tenant', jsonb_build_object(
      'slug', v_org.slug,
      'display_name', v_org.display_name,
      'app_name', v_org.app_name,
      'logo_url', v_org.logo_url,
      'accent_hex', v_org.accent_hex,
      'accent_soft_hex', v_org.accent_soft_hex,
      'tagline', v_org.tagline,
      'headline', v_org.headline,
      'description', v_org.description,
      'whatsapp_number', v_org.whatsapp_number,
      'free_shipping_threshold_cents', v_org.free_shipping_threshold_cents,
      'currency', v_org.currency
    ),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',c.id,'name',c.name,'slug',c.slug,
        'description',c.description,'sort_order',c.sort_order
      ) order by c.sort_order,c.name)
      from public.food_categories c
      where c.organization_id=v_org.id and c.is_active=true
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,
        'category_id',p.category_id,
        'name',p.name,
        'slug',p.slug,
        'description',p.description,
        'image_url',p.image_url,
        'emoji',p.emoji,
        'price_cents',p.price_cents,
        'compare_at_price_cents',p.compare_at_price_cents,
        'sort_order',p.sort_order,
        'sku',p.sku,
        'modifier_groups',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',g.id,
            'name',g.name,
            'min_select',g.min_select,
            'max_select',g.max_select,
            'is_required',g.is_required,
            'sort_order',g.sort_order,
            'modifiers',coalesce((
              select jsonb_agg(jsonb_build_object(
                'id',m.id,
                'name',m.name,
                'price_delta_cents',m.price_delta_cents,
                'sort_order',m.sort_order
              ) order by m.sort_order,m.name)
              from public.food_modifiers m
              where m.organization_id=v_org.id
                and m.group_id=g.id
                and m.is_available=true
            ), '[]'::jsonb)
          ) order by g.sort_order,g.name)
          from public.food_modifier_groups g
          where g.organization_id=v_org.id
            and g.product_id=p.id
            and g.is_active=true
        ), '[]'::jsonb)
      ) order by p.sort_order,p.name)
      from public.food_products p
      where p.organization_id=v_org.id and p.is_available=true
    ), '[]'::jsonb),
    'recommendation_rules', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',r.id,
        'kind',r.kind,
        'name',r.name,
        'trigger_product_id',r.trigger_product_id,
        'recommended_product_id',r.recommended_product_id,
        'threshold_cents',r.threshold_cents,
        'priority',r.priority,
        'benefit',r.config->>'benefit'
      ) order by r.priority,r.name)
      from public.food_recommendation_rules r
      where r.organization_id=v_org.id and r.is_active=true
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;
REVOKE EXECUTE ON FUNCTION public.fn_food_public_catalog(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_food_public_catalog(text) TO anon, authenticated;

create or replace function public.fn_food_checkout(
  p_tenant_slug text,
  p_idempotency_key text,
  p_session_key text,
  p_customer_name text,
  p_phone text,
  p_fulfillment text,
  p_payment_method text,
  p_address_notes text,
  p_marketing_consent boolean,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_org_id uuid;
  v_phone text;
  v_contact_id uuid;
  v_order_id uuid;
  v_external_id text;
  v_total bigint := 0;
  v_item jsonb;
  v_product record;
  v_qty integer;
  v_modifier_ids uuid[];
  v_modifier_count integer;
  v_matched_modifier_count integer;
  v_modifier_delta bigint;
  v_modifier_snapshot jsonb;
  v_group record;
  v_group_selected integer;
  v_rule_id uuid;
  v_trigger_product_id uuid;
  v_line_total bigint;
  v_request_hash bytea;
  v_request_payload jsonb;
  v_existing record;
  v_result jsonb;
  v_item_seq integer := 0;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 or length(trim(p_idempotency_key)) > 128 then
    raise exception 'idempotency_key_invalid' using errcode = '22023';
  end if;
  if p_session_key is null or length(trim(p_session_key)) < 6 or length(trim(p_session_key)) > 160 then
    raise exception 'session_key_invalid' using errcode = '22023';
  end if;
  if nullif(trim(p_customer_name), '') is null or length(trim(p_customer_name)) > 160 then
    raise exception 'customer_name_invalid' using errcode = '22023';
  end if;
  if lower(trim(p_fulfillment)) not in ('retirada','entrega') then
    raise exception 'fulfillment_invalid' using errcode = '22023';
  end if;
  if lower(trim(p_payment_method)) not in ('pix','cartao','cartão','dinheiro') then
    raise exception 'payment_method_invalid' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'items_invalid' using errcode = '22023';
  end if;

  select o.id into v_org_id
  from public.organizations o
  join public.food_commerce_settings s on s.organization_id = o.id
  where o.slug::text = lower(trim(p_tenant_slug))
    and o.status = 'active'
    and s.is_enabled = true;
  if v_org_id is null then
    raise exception 'food_tenant_not_found' using errcode = 'P0002';
  end if;

  v_phone := public.fn_food_normalize_phone(p_phone);
  v_request_payload := jsonb_build_object(
    'tenant_slug', lower(trim(p_tenant_slug)),
    'session_key', trim(p_session_key),
    'customer_name', trim(p_customer_name),
    'phone', v_phone,
    'fulfillment', lower(trim(p_fulfillment)),
    'payment_method', lower(trim(p_payment_method)),
    'address_notes', coalesce(p_address_notes, ''),
    'marketing_consent', coalesce(p_marketing_consent, false),
    'items', p_items
  );
  v_request_hash := digest(convert_to(v_request_payload::text, 'UTF8'), 'sha256');

  perform pg_advisory_xact_lock(hashtextextended(v_org_id::text || ':' || trim(p_idempotency_key), 0));
  select request_hash, response_body, expires_at into v_existing
  from public.idempotency_keys
  where organization_id=v_org_id
    and key=trim(p_idempotency_key)
    and endpoint='food_checkout';

  if found and v_existing.expires_at > now() then
    if v_existing.request_hash <> v_request_hash then
      raise exception 'idempotency_key_conflict' using errcode='23505';
    end if;
    return v_existing.response_body;
  elsif found then
    delete from public.idempotency_keys
    where organization_id=v_org_id
      and key=trim(p_idempotency_key)
      and endpoint='food_checkout';
  end if;

  select c.id into v_contact_id
  from public.contacts c
  where c.organization_id=v_org_id
    and c.phone_number=v_phone
    and c.is_merged_into is null
  limit 1;

  if v_contact_id is null then
    insert into public.contacts (
      organization_id,name,display_name,phone_number,source,source_metadata
    ) values (
      v_org_id,trim(p_customer_name),trim(p_customer_name),v_phone,
      'food_commerce',
      jsonb_build_object('tenant_slug',lower(trim(p_tenant_slug)),'first_order_session',trim(p_session_key))
    )
    on conflict do nothing
    returning id into v_contact_id;

    if v_contact_id is null then
      select c.id into v_contact_id
      from public.contacts c
      where c.organization_id=v_org_id
        and (c.phone_number=v_phone or c.wa_identity='phone:' || v_phone)
        and c.is_merged_into is null
      limit 1;
    end if;
  else
    update public.contacts
      set name=coalesce(name,trim(p_customer_name)),
          display_name=coalesce(display_name,trim(p_customer_name)),
          updated_at=now()
      where id=v_contact_id;
  end if;

  if v_contact_id is null then
    raise exception 'contact_resolution_failed';
  end if;

  if coalesce(p_marketing_consent,false) then
    update public.contacts
    set consent=jsonb_set(
          consent,
          '{marketing}',
          jsonb_build_object('granted_at',now(),'source','food_checkout','version','v1'),
          true
        ),
        updated_at=now()
    where id=v_contact_id;
  end if;

  v_external_id := trim(p_idempotency_key);
  insert into public.orders (
    organization_id,external_id,external_provider,customer_external_id,
    contact_id,status,total_cents,currency,payment_method,fulfillment_status,
    payload,ordered_at,updated_at_remote
  ) values (
    v_org_id,v_external_id,'deskcomm_food',v_phone,v_contact_id,'pending',0,'BRL',
    case when lower(trim(p_payment_method)) in ('cartao','cartão') then 'cartao'
         else lower(trim(p_payment_method)) end,
    null,
    jsonb_build_object(
      'source','food_commerce',
      'session_key',trim(p_session_key),
      'fulfillment',lower(trim(p_fulfillment)),
      'address_notes',coalesce(p_address_notes,''),
      'marketing_consent_at_checkout',coalesce(p_marketing_consent,false)
    ),
    now(),now()
  ) returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_item_seq := v_item_seq + 1;

    begin
      v_qty := coalesce((v_item->>'quantity')::integer,0);
    exception when others then
      raise exception 'item_quantity_invalid:%',v_item_seq using errcode='22023';
    end;
    if v_qty < 1 or v_qty > 99 then
      raise exception 'item_quantity_invalid:%',v_item_seq using errcode='22023';
    end if;

    begin
      select p.id,p.name,p.price_cents into v_product
      from public.food_products p
      where p.id=(v_item->>'product_id')::uuid
        and p.organization_id=v_org_id
        and p.is_available=true;
    exception when invalid_text_representation then
      raise exception 'product_id_invalid:%',v_item_seq using errcode='22023';
    end;
    if not found then
      raise exception 'product_not_available:%',v_item_seq using errcode='P0002';
    end if;

    begin
      select coalesce(array_agg(x.id order by x.id),'{}'::uuid[]),count(*)
        into v_modifier_ids,v_modifier_count
      from (
        select (value #>> '{}')::uuid as id
        from jsonb_array_elements(coalesce(v_item->'modifier_ids','[]'::jsonb))
      ) x;
    exception when others then
      raise exception 'modifier_ids_invalid:%',v_item_seq using errcode='22023';
    end;

    if coalesce(array_length(v_modifier_ids,1),0)
      <> coalesce((select count(distinct x) from unnest(v_modifier_ids) x),0) then
      raise exception 'modifier_duplicate:%',v_item_seq using errcode='22023';
    end if;

    select count(*),coalesce(sum(m.price_delta_cents),0),
           coalesce(jsonb_agg(jsonb_build_object(
             'id',m.id,'name',m.name,'group_id',g.id,'group_name',g.name,
             'price_delta_cents',m.price_delta_cents
           ) order by g.sort_order,m.sort_order,m.name),'[]'::jsonb)
      into v_matched_modifier_count,v_modifier_delta,v_modifier_snapshot
    from public.food_modifiers m
    join public.food_modifier_groups g
      on g.id=m.group_id and g.organization_id=m.organization_id
    where m.organization_id=v_org_id
      and g.product_id=v_product.id
      and g.is_active=true
      and m.is_available=true
      and m.id=any(v_modifier_ids);

    if v_matched_modifier_count <> v_modifier_count then
      raise exception 'modifier_not_available:%',v_item_seq using errcode='P0002';
    end if;

    for v_group in
      select g.id,g.name,g.min_select,g.max_select,g.is_required
      from public.food_modifier_groups g
      where g.organization_id=v_org_id
        and g.product_id=v_product.id
        and g.is_active=true
    loop
      select count(*) into v_group_selected
      from public.food_modifiers m
      where m.organization_id=v_org_id
        and m.group_id=v_group.id
        and m.id=any(v_modifier_ids);

      if v_group_selected < greatest(v_group.min_select,case when v_group.is_required then 1 else 0 end)
         or v_group_selected > v_group.max_select then
        raise exception 'modifier_group_selection_invalid:%:%',v_item_seq,v_group.name using errcode='22023';
      end if;
    end loop;

    v_rule_id := null;
    v_trigger_product_id := null;
    if nullif(v_item->>'recommendation_rule_id','') is not null then
      begin
        v_rule_id := (v_item->>'recommendation_rule_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'recommendation_rule_invalid:%',v_item_seq using errcode='22023';
      end;

      select r.trigger_product_id into v_trigger_product_id
      from public.food_recommendation_rules r
      where r.id=v_rule_id
        and r.organization_id=v_org_id
        and r.is_active=true
        and r.recommended_product_id=v_product.id
        and r.kind in ('upsell','cross_sell','upgrade','combo','order_bump')
        and (
          r.trigger_product_id is null
          or exists (
            select 1 from jsonb_array_elements(p_items) source_item
            where source_item->>'product_id'=r.trigger_product_id::text
          )
        );
      if not found then
        raise exception 'recommendation_rule_invalid:%',v_item_seq using errcode='22023';
      end if;
    end if;

    v_line_total := (v_product.price_cents + v_modifier_delta) * v_qty;
    if v_line_total < 0 then
      raise exception 'line_total_invalid:%',v_item_seq using errcode='22023';
    end if;
    v_total := v_total + v_line_total;

    insert into public.food_order_items (
      organization_id,order_id,product_id,product_name_snapshot,
      unit_price_cents,quantity,line_total_cents,selected_modifiers,
      added_via_recommendation,recommendation_rule_id
    ) values (
      v_org_id,v_order_id,v_product.id,v_product.name,
      v_product.price_cents+v_modifier_delta,v_qty,v_line_total,v_modifier_snapshot,
      v_rule_id is not null,v_rule_id
    );

    if v_rule_id is not null then
      insert into public.food_recommendation_events (
        organization_id,session_key,rule_id,trigger_product_id,recommended_product_id,
        order_id,event_type,attributed_revenue_cents,metadata
      ) values (
        v_org_id,trim(p_session_key),v_rule_id,v_trigger_product_id,v_product.id,
        v_order_id,'purchased',v_line_total,
        jsonb_build_object('quantity',v_qty,'source','food_checkout')
      );
    end if;
  end loop;

  update public.orders
    set total_cents=v_total,
        payload=payload || jsonb_build_object('server_calculated_total_cents',v_total),
        updated_at=now()
    where id=v_order_id;

  perform public.emit_event(
    'order.created','order',v_order_id,
    jsonb_build_object(
      'order_id',v_order_id,
      'contact_id',v_contact_id,
      'total_cents',v_total,
      'external_provider','deskcomm_food',
      'session_key',trim(p_session_key),
      'fulfillment',lower(trim(p_fulfillment))
    ),
    jsonb_build_object('source','food_checkout','idempotency_key',trim(p_idempotency_key)),
    v_org_id
  );

  select jsonb_build_object(
    'order_id',v_order_id,
    'external_id',v_external_id,
    'contact_id',v_contact_id,
    'status','pending',
    'total_cents',v_total,
    'currency','BRL'
  ) into v_result;

  insert into public.idempotency_keys (
    organization_id,key,endpoint,request_hash,status_code,response_body,expires_at
  ) values (
    v_org_id,trim(p_idempotency_key),'food_checkout',v_request_hash,201,v_result,now()+interval '24 hours'
  );

  return v_result;
end;
$$;
REVOKE EXECUTE ON FUNCTION public.fn_food_checkout(text,text,text,text,text,text,text,text,boolean,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_food_checkout(text,text,text,text,text,text,text,text,boolean,jsonb)
  TO service_role;

create or replace function public.fn_food_track_recommendation(
  p_tenant_slug text,
  p_session_key text,
  p_event_key text,
  p_rule_id uuid,
  p_event_type text
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_org_id uuid;
  v_trigger_product_id uuid;
  v_recommended_product_id uuid;
  v_event_id uuid;
begin
  if p_session_key is null or length(trim(p_session_key)) < 6 or length(trim(p_session_key)) > 160 then
    raise exception 'session_key_invalid' using errcode='22023';
  end if;
  if p_event_key is null or length(trim(p_event_key)) < 8 or length(trim(p_event_key)) > 180 then
    raise exception 'event_key_invalid' using errcode='22023';
  end if;
  if p_event_type not in ('shown','clicked','added','removed') then
    raise exception 'recommendation_event_type_invalid' using errcode='22023';
  end if;

  select o.id into v_org_id
  from public.organizations o
  join public.food_commerce_settings s on s.organization_id=o.id
  where o.slug::text=lower(trim(p_tenant_slug))
    and o.status='active'
    and s.is_enabled=true;
  if v_org_id is null then
    raise exception 'food_tenant_not_found' using errcode='P0002';
  end if;

  select r.trigger_product_id,r.recommended_product_id
    into v_trigger_product_id,v_recommended_product_id
  from public.food_recommendation_rules r
  where r.id=p_rule_id
    and r.organization_id=v_org_id
    and r.is_active=true;
  if not found then
    raise exception 'recommendation_rule_not_found' using errcode='P0002';
  end if;

  insert into public.food_recommendation_events (
    organization_id,session_key,event_key,rule_id,trigger_product_id,
    recommended_product_id,event_type,attributed_revenue_cents,metadata
  ) values (
    v_org_id,trim(p_session_key),trim(p_event_key),p_rule_id,v_trigger_product_id,
    v_recommended_product_id,p_event_type,0,jsonb_build_object('source','food_storefront')
  )
  on conflict (organization_id,event_key) where event_key is not null do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select id into v_event_id
    from public.food_recommendation_events
    where organization_id=v_org_id and event_key=trim(p_event_key)
    limit 1;
  end if;

  return v_event_id;
end;
$$;
REVOKE EXECUTE ON FUNCTION public.fn_food_track_recommendation(text,text,text,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_food_track_recommendation(text,text,text,uuid,text)
  TO service_role;

create or replace function public.fn_food_commerce_metrics(
  p_organization_id uuid,
  p_from timestamptz default (now() - interval '30 days'),
  p_to timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path to 'public', 'pg_temp'
as $$
declare
  v_orders bigint;
  v_revenue bigint;
  v_avg_ticket numeric;
  v_incremental bigint;
  v_orders_with_rec bigint;
  v_attach numeric;
  v_uplift numeric;
  v_share numeric;
  v_pairs jsonb;
begin
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'metrics_period_invalid' using errcode='22023';
  end if;
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode='42501';
  end if;
  if not (public.fn_role_at_least(p_organization_id,'viewer') or public.fn_is_platform_admin()) then
    raise exception 'caller_not_authorized_for_org' using errcode='42501';
  end if;

  select count(*),coalesce(sum(o.total_cents),0),coalesce(avg(o.total_cents),0)
    into v_orders,v_revenue,v_avg_ticket
  from public.orders o
  where o.organization_id=p_organization_id
    and o.external_provider='deskcomm_food'
    and o.ordered_at>=p_from and o.ordered_at<p_to
    and o.status<>'cancelled';

  select coalesce(sum(e.attributed_revenue_cents),0)
    into v_incremental
  from public.food_recommendation_events e
  join public.orders o on o.id=e.order_id and o.organization_id=e.organization_id
  where e.organization_id=p_organization_id
    and e.event_type='purchased'
    and o.ordered_at>=p_from and o.ordered_at<p_to
    and o.status<>'cancelled';

  select count(distinct oi.order_id)
    into v_orders_with_rec
  from public.food_order_items oi
  join public.orders o on o.id=oi.order_id and o.organization_id=oi.organization_id
  where oi.organization_id=p_organization_id
    and oi.added_via_recommendation=true
    and o.ordered_at>=p_from and o.ordered_at<p_to
    and o.status<>'cancelled';

  v_attach := case when v_orders>0 then (v_orders_with_rec::numeric/v_orders::numeric)*100 else 0 end;
  v_uplift := case when (v_revenue-v_incremental)>0 then (v_incremental::numeric/(v_revenue-v_incremental)::numeric)*100 else 0 end;
  v_share := case when v_revenue>0 then (v_incremental::numeric/v_revenue::numeric)*100 else 0 end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'product_a',q.product_a,
    'product_b',q.product_b,
    'orders_together',q.orders_together
  ) order by q.orders_together desc,q.product_a,q.product_b),'[]'::jsonb)
  into v_pairs
  from (
    select p1.name as product_a,p2.name as product_b,count(distinct i1.order_id) as orders_together
    from public.food_order_items i1
    join public.food_order_items i2
      on i2.organization_id=i1.organization_id
     and i2.order_id=i1.order_id
     and i2.product_id>i1.product_id
    join public.orders o on o.id=i1.order_id and o.organization_id=i1.organization_id
    join public.food_products p1 on p1.id=i1.product_id and p1.organization_id=i1.organization_id
    join public.food_products p2 on p2.id=i2.product_id and p2.organization_id=i2.organization_id
    where i1.organization_id=p_organization_id
      and o.ordered_at>=p_from and o.ordered_at<p_to
      and o.status<>'cancelled'
      and i1.product_id is not null and i2.product_id is not null
    group by p1.name,p2.name
    order by orders_together desc,p1.name,p2.name
    limit 10
  ) q;

  return jsonb_build_object(
    'period',jsonb_build_object('from',p_from,'to',p_to),
    'orders_count',v_orders,
    'gross_revenue_cents',v_revenue,
    'average_ticket_cents',round(v_avg_ticket),
    'incremental_revenue_cents',v_incremental,
    'orders_with_recommendation',v_orders_with_rec,
    'attach_rate_pct',round(v_attach,2),
    'uplift_pct',round(v_uplift,2),
    'recommendation_revenue_share_pct',round(v_share,2),
    'top_product_pairs',v_pairs
  );
end;
$$;
REVOKE EXECUTE ON FUNCTION public.fn_food_commerce_metrics(uuid,timestamptz,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_food_commerce_metrics(uuid,timestamptz,timestamptz)
  TO authenticated;

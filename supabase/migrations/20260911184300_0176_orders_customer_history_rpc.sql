-- 0176_orders_customer_history_rpc
-- EPIC-21 (Athos): RPC para a Sarah (motor de relacionamento foodservice)
-- consultar o histórico de compras de um cliente específico e gerar campanhas
-- de recompra / reativação. Time Athos consome via API REST que wrappa esta
-- RPC; a Sarah consome via MCP tool que wrappa a mesma RPC.
--
-- Por que RPC e não query direta na API: o agregado `favorite_products`
-- (top-N produtos) e a paginação por cursor `(ordered_at, id) DESC` precisam
-- rodar no banco para evitar N+1; uma `view` não dá paginação cursor e não
-- esconde a forma do schema.
--
-- SECURITY INVOKER + filtro manual de `organization_id`: o caller (admin
-- client do MCP server ou usuário autenticado via `.rpc`) tem permissão
-- própria; a função confia no filtro que ela mesma aplica. Service-role
-- atravessa RLS e o filtro é o que garante isolamento. User autenticado tem
-- RLS, e o filtro reforça.
--
-- STABLE: nenhuma chamada a `now()` interna — `now()` é argumento `p_now`
-- (default now()). Sem isso o planner não otimiza e `days_since_last_order`
-- muda entre linhas da mesma query, o que quebraria uma campanha.
--
-- Idempotente: `create or replace` + `create index if not exists` +
-- `revoke ... from public, anon, authenticated` + `grant ... to authenticated,
-- service_role` (issue #128 — função nova em `public` nasce EXPOSTA pelas
-- duas origens: ALTER DEFAULT PRIVILEGES ... TO anon e o grant a PUBLIC).
create or replace function public.fn_orders_customer_history(
  p_org uuid,
  p_phone text,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_status text default null,
  p_limit int default 50,
  p_cursor text default null,
  p_now timestamptz default now()
) returns jsonb
language plpgsql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $$
declare
  v_phone_e164 text;
  v_contact_id uuid;
  v_contact_name text;
  v_contact_display_name text;
  v_contact_phone text;
  v_contact_blocked boolean;
  v_contact_anonymized boolean;
  v_contact_tags text[];
  v_contact_last_activity timestamptz;
  v_summary jsonb;
  v_orders jsonb;
  v_next_cursor text;
  v_cursor_ts timestamptz;
  v_cursor_id uuid;
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 200));
  v_statuses text[] := case
    when p_status is null or p_status = '' then
      array['pending','paid','fulfilled','shipped','delivered','cancelled','refunded']::text[]
    when p_status = 'not_cancelled' then
      array['pending','paid','fulfilled','shipped','delivered','refunded']::text[]
    when p_status = 'completed' then
      array['paid','fulfilled','shipped','delivered']::text[]
    else
      array[p_status]::text[]
  end;
  v_total_orders int;
  v_total_spent bigint;
  v_avg_ticket bigint;
  v_first_order timestamptz;
  v_last_order timestamptz;
  v_currency text;
  v_customer_found boolean := false;
  v_empty_summary jsonb := jsonb_build_object(
    'total_orders', 0,
    'total_spent_cents', 0,
    'avg_ticket_cents', 0,
    'currency', 'BRL',
    'first_order_at', null,
    'last_order_at', null,
    'days_since_last_order', null,
    'favorite_products', '[]'::jsonb
  );
begin
  -- 1. Normaliza telefone para E.164 (reusa o normalizador canônico do food).
  --    `phone_required` (22023) e `phone_invalid` (22023) sobem ao caller.
  v_phone_e164 := public.fn_food_normalize_phone(p_phone);

  -- 2. Resolve contato na org. 1 telefone = 1 contato é o invariante
  --    (uniq_contacts_org_phone); se houver duplicado por bug pré-merge, pega
  --    o mais recente ativo (não-anonimizado, não-mergeado).
  select c.id, c.name, c.display_name, c.phone_number, c.is_blocked,
         c.is_anonymized, c.tags, c.last_activity_at
    into v_contact_id, v_contact_name, v_contact_display_name, v_contact_phone,
         v_contact_blocked, v_contact_anonymized, v_contact_tags, v_contact_last_activity
    from public.contacts c
   where c.organization_id = p_org
     and c.phone_number = v_phone_e164
     and c.is_merged_into is null
   order by c.created_at desc
   limit 1;

  if v_contact_id is null then
    -- Cliente novo / nunca pediu: devolve o "shape vazio" em vez de 404. Sarah
    -- decide se vale iniciar uma campanha cold-lead; a API não decide isso.
    return jsonb_build_object(
      'customer_found', false,
      'query_phone_e164', v_phone_e164,
      'summary', v_empty_summary,
      'orders', '[]'::jsonb,
      'next_cursor', null
    );
  end if;

  v_customer_found := true;

  -- 3. Decodifica cursor opaco: base64("{ts}|{id}"). Cursor mal formado = 22023.
  if p_cursor is not null then
    begin
      declare
        v_decoded text;
      begin
        v_decoded := convert_from(decode(p_cursor, 'base64'), 'UTF8');
        v_cursor_ts := split_part(v_decoded, '|', 1)::timestamptz;
        v_cursor_id := split_part(v_decoded, '|', 2)::uuid;
      end;
    exception when others then
      raise exception 'cursor_invalid' using errcode = '22023';
    end;
  end if;

  -- 4. Agregados (mesma janela da lista — `total_orders` reflete o filtro).
  --    `total_spent`/`avg_ticket` excluem cancelados e estornados: o que o
  --    cliente PAGOU de fato, não o que foi revertido. Sarah usa isso pra
  --    falar de "seus últimos pedidos" sem inflar com cancelados.
  select
    count(*),
    coalesce(sum(o.total_cents) filter (where o.status not in ('cancelled','refunded')), 0),
    case
      when count(*) filter (where o.status not in ('cancelled','refunded')) = 0 then 0
      else round(
        coalesce(sum(o.total_cents) filter (where o.status not in ('cancelled','refunded')), 0)::numeric
        / nullif(count(*) filter (where o.status not in ('cancelled','refunded')), 0)::numeric
      )::bigint
    end,
    min(o.ordered_at),
    max(o.ordered_at),
    coalesce(nullif(max(o.currency), ''), 'BRL')
    into v_total_orders, v_total_spent, v_avg_ticket, v_first_order, v_last_order, v_currency
    from public.orders o
   where o.organization_id = p_org
     and o.contact_id = v_contact_id
     and (p_from is null or o.ordered_at >= p_from)
     and (p_to is null or o.ordered_at < p_to)
     and o.status = any(v_statuses);

  -- 5. Top 5 produtos (frequência × quantidade). `food_order_items` é a fonte
  --    de produtos; pedidos que não têm itens (nuvemshop/vtex/shopify) ficam
  --    fora do top — o cardápio da loja é o que dá pra Sarah oferecer.
  v_summary := jsonb_build_object(
    'total_orders', v_total_orders,
    'total_spent_cents', v_total_spent,
    'avg_ticket_cents', v_avg_ticket,
    'currency', v_currency,
    'first_order_at', v_first_order,
    'last_order_at', v_last_order,
    'days_since_last_order', case
      when v_last_order is null then null
      else greatest(0, extract(epoch from (p_now - v_last_order))::bigint / 86400)
    end,
    'favorite_products', (
      select coalesce(jsonb_agg(row_to_json(p)), '[]'::jsonb)
        from (
          select foi.product_name_snapshot as product_name,
                 sum(foi.quantity)::int as quantity,
                 count(distinct foi.order_id)::int as order_count
            from public.food_order_items foi
            join public.orders o on o.id = foi.order_id and o.organization_id = foi.organization_id
           where foi.organization_id = p_org
             and o.contact_id = v_contact_id
             and o.status = any(v_statuses)
             and (p_from is null or o.ordered_at >= p_from)
             and (p_to is null or o.ordered_at < p_to)
           group by foi.product_name_snapshot
           order by quantity desc, order_count desc, foi.product_name_snapshot asc
           limit 5
        ) p
    )
  );

  -- 6. Página de pedidos (cursor DESC; `+1` é o truque padrão pra detectar
  --    "tem mais" sem count extra).
  with page_raw as (
    select o.id, o.external_id, o.external_provider, o.status, o.total_cents,
           o.currency, o.payment_method, o.fulfillment_status, o.tracking_code,
           o.ordered_at, o.is_anonymized
      from public.orders o
     where o.organization_id = p_org
       and o.contact_id = v_contact_id
       and (p_from is null or o.ordered_at >= p_from)
       and (p_to is null or o.ordered_at < p_to)
       and o.status = any(v_statuses)
       and (
         p_cursor is null
         or (o.ordered_at, o.id) < (v_cursor_ts, v_cursor_id)
       )
     order by o.ordered_at desc, o.id desc
     limit v_limit + 1
  ),
  page as (
    select * from page_raw limit v_limit
  ),
  has_more as (
    select count(*) > v_limit as more from page_raw
  ),
  last_row as (
    select ordered_at, id from page
     order by ordered_at desc, id desc
     limit 1
  )
  select
    coalesce((
      select jsonb_agg(row_to_json(p))
        from (
          select id, external_id, external_provider, status, total_cents, currency,
                 payment_method, fulfillment_status, tracking_code, ordered_at,
                 is_anonymized,
                 case when is_anonymized then 'pedido anonimizado a pedido do titular' else null end
                   as anonymization_notice
            from page
        ) p
    ), '[]'::jsonb),
    case
      when (select more from has_more) then
        encode(convert_to(
          (select ordered_at::text from last_row) || '|' || (select id::text from last_row),
          'UTF8'
        ), 'base64')
      else null
    end
    into v_orders, v_next_cursor;

  -- 7. Enriquece cada pedido com seus itens (1 round-trip agregando todos os
  --    itens da página). Pedidos não-food (nuvemshop/vtex/shopify) voltam
  --    com `items: []` — sem erro.
  v_orders := (
    select coalesce(jsonb_agg(
      o || jsonb_build_object(
        'items', coalesce((
          select jsonb_agg(row_to_json(i) order by i.created_at)
            from (
              select id, product_id, product_name_snapshot, unit_price_cents,
                     quantity, line_total_cents, selected_modifiers,
                     added_via_recommendation
                from public.food_order_items
               where order_id = (o->>'id')::uuid
                 and organization_id = p_org
            ) i
        ), '[]'::jsonb)
      )
    ), '[]'::jsonb)
      from jsonb_array_elements(v_orders) o
  );

  -- 8. Resposta final.
  return jsonb_build_object(
    'customer_found', v_customer_found,
    'query_phone_e164', v_phone_e164,
    'customer', jsonb_build_object(
      'id', v_contact_id,
      'name', v_contact_name,
      'display_name', v_contact_display_name,
      'phone_number', v_contact_phone,
      'is_blocked', v_contact_blocked,
      'is_anonymized', v_contact_anonymized,
      'tags', coalesce(v_contact_tags, '{}'::text[]),
      'last_activity_at', v_contact_last_activity
    ),
    'summary', v_summary,
    'orders', v_orders,
    'next_cursor', v_next_cursor
  );
end;
$$;

-- ACL: revoke das duas origens (issue #128 — não revogar só de uma deixa a
-- função alcançável pela anon key).
revoke execute on function public.fn_orders_customer_history(
  uuid, text, timestamptz, timestamptz, text, int, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.fn_orders_customer_history(
  uuid, text, timestamptz, timestamptz, text, int, text, timestamptz
) to authenticated, service_role;

-- Índice composto para a paginação (organization_id + contact_id + ordered_at
-- DESC + id DESC). Sem ele, a query fica cara em tenants com muito histórico;
-- a ordem do índice é a ordem do ORDER BY (Postgres não consegue inverter).
create index if not exists orders_org_contact_ordered_idx
  on public.orders (organization_id, contact_id, ordered_at desc, id desc)
  where contact_id is not null;

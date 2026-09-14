-- 0177_customers_by_purchase_recency_rpc
-- EPIC-21 (Athos) PARTE 3: audiencia de campanha por recorrencia de compra.
--
-- Por que RPC e nao query direta: a query agrega o ULTIMO pedido elegivel por
-- contato (MAX ordered_at + count + sum) em uma janela de tempo, e a pagina
-- por cursor opaco (last_order_at, contact_id). Uma view nao daria paginacao
-- cursor; query direta no handler vaza N+1 e nao escala para audiencia com
-- milhares de contatos.
--
-- LGPD (PARTE 7 do briefing): ja filtramos no WHERE, antes de retornar.
--   - is_blocked=true -> excluido
--   - is_anonymized=true -> excluido
--   - consent -> 'marketing' ->> 'granted_at' IS NULL -> excluido
--     (consent = {} tambem cai aqui porque ->> retorna NULL quando path nao
--     existe). A politica de opt-in e estrita: sem grant explicito, nao manda
--     mensagem de marketing. A API de audiencia devolve a flag
--     `has_marketing_consent` no resultado pra deixar claro o porvao de cada
--     contato.
--   - A API NAO dispara mensagem (PARTE 7: "selecao de audiencia != disparo").
--     Sarah dispara via outro caminho (WPP/agent-engine), respeitando os
--     mesmos flags.
--
-- Multi-tenancy: filtro manual de organization_id em TODA query. Mesmo que o
-- caller seja service-role (atravessa RLS), o filtro isola. Mesmo que o
-- caller seja user autenticado, a RLS da tabela contacts/orders ja bloqueia,
-- e o filtro explicito e a defesa em profundidade.
--
-- has_orders:
--   - true (default) -> so contatos COM pedido, E o ultimo pedido elegivel
--     ocorreu ha p_inactive_days ou mais. Caso de uso principal: reativacao.
--   - false -> so contatos SEM pedido (cold leads). Caso de uso: aquisicao
--     de quem nunca comprou. Documentado como flag explicita porque cold
--     leads misturados com reativacao distorcem a metrica de "inatividade".
--
-- STABLE: now() vem como argumento p_now (default now()). Sem isso o
-- planner nao otimiza e days_since_last_order muda entre linhas da mesma
-- query -- quebraria a consistencia da pagina (mover o limite enquanto
-- pagina).
--
-- Idempotente: create or replace + revoke ... from public, anon, authenticated
-- + grant ... to authenticated, service_role (issue #128).
create or replace function public.fn_customers_by_purchase_recency(
  p_org uuid,
  p_inactive_days int,
  p_min_orders int default 0,
  p_min_spent_cents bigint default 0,
  p_status text default 'not_cancelled',
  p_limit int default 100,
  p_cursor text default null,
  p_has_orders boolean default true,
  p_now timestamptz default now()
) returns jsonb
language plpgsql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 100), 500));
  v_statuses text[] := case
    when p_status is null or p_status = '' or p_status = 'not_cancelled' then
      array['pending','paid','fulfilled','shipped','delivered','refunded']::text[]
    when p_status = 'completed' then
      array['paid','fulfilled','shipped','delivered']::text[]
    else
      array[p_status]::text[]
  end;
  v_threshold timestamptz := p_now - make_interval(days => p_inactive_days);
  v_cursor_ts timestamptz;
  v_cursor_id uuid;
  v_cursor_is_cold boolean := false;
  v_candidates jsonb;
  v_next_cursor text;
begin
  if p_inactive_days is null or p_inactive_days < 0 or p_inactive_days > 3650 then
    raise exception 'inactive_days_out_of_range' using errcode = '22023';
  end if;

  if p_cursor is not null then
    begin
      declare
        v_decoded text;
      begin
        v_decoded := convert_from(decode(p_cursor, 'base64'), 'UTF8');
        v_cursor_is_cold := split_part(v_decoded, '|', 1) = 'cold';
        if v_cursor_is_cold then
          if p_has_orders then
            raise exception 'cursor_mode_mismatch';
          end if;
          v_cursor_ts := null;
        else
          if not p_has_orders then
            raise exception 'cursor_mode_mismatch';
          end if;
          v_cursor_ts := split_part(v_decoded, '|', 1)::timestamptz;
        end if;
        v_cursor_id := split_part(v_decoded, '|', 2)::uuid;
      end;
    exception when others then
      raise exception 'cursor_invalid' using errcode = '22023';
    end;
  end if;

  -- CTE 1: contatos elegiveis do org (LGPD ja filtrado). Opt-in de marketing
  -- ESTREITO: sem granted_at, fora. consent = {} tambem cai fora (jsonb ->>
  -- retorna NULL quando path nao existe, e isso e o nosso gate).
  with eligible_contacts as (
    select
      c.id as contact_id,
      c.display_name,
      c.phone_number,
      c.last_activity_at,
      c.tags,
      (c.consent -> 'marketing' ->> 'granted_at') is not null as has_marketing_consent
    from public.contacts c
    where c.organization_id = p_org
      and c.is_merged_into is null
      and c.is_blocked = false
      and c.is_anonymized = false
      and (c.consent -> 'marketing' ->> 'granted_at') is not null
  ),
  -- CTE 2: agregado por contato (ULTIMO pedido elegivel + total orders +
  -- total spent + ticket medio). Filtra pelo p_status uma vez -- o mesmo
  -- agregado serve para popular last_order e o summary de cada candidato.
  orders_agg as (
    select
      o.contact_id,
      count(*) as total_orders,
      coalesce(sum(o.total_cents) filter (where o.status not in ('cancelled','refunded')), 0)::bigint as total_spent_cents,
      max(o.ordered_at) as last_order_at,
      -- last_order_id: o id do pedido com a maior ordered_at (DENTRE elegiveis)
      (
        select o2.id
          from public.orders o2
         where o2.organization_id = p_org
           and o2.contact_id = o.contact_id
           and o2.status = any(v_statuses)
         order by o2.ordered_at desc, o2.id desc
         limit 1
      ) as last_order_id
    from public.orders o
    where o.organization_id = p_org
      and o.status = any(v_statuses)
    group by o.contact_id
  ),
  -- CTE 3: filtro composto (inatividade + min_orders + min_spent + has_orders)
  filtered as (
    select
      ec.contact_id,
      ec.display_name,
      ec.phone_number,
      ec.last_activity_at,
      ec.tags,
      ec.has_marketing_consent,
      coalesce(oa.total_orders, 0) as total_orders,
      coalesce(oa.total_spent_cents, 0) as total_spent_cents,
      oa.last_order_at,
      oa.last_order_id,
      case
        when oa.last_order_at is null then null
        else greatest(0, extract(epoch from (p_now - oa.last_order_at))::bigint / 86400)
      end as days_since_last_order
    from eligible_contacts ec
    left join orders_agg oa on oa.contact_id = ec.contact_id
    where
      -- p_has_orders=true  -> so quem TEM pedido, E o ultimo pedido
      --                     ocorreu ha p_inactive_days ou mais.
      -- p_has_orders=false -> so quem NAO tem pedido (cold lead).
      (
        (p_has_orders = true  and oa.last_order_at is not null and oa.last_order_at <= v_threshold)
        or
        (p_has_orders = false and oa.last_order_at is null)
      )
      and coalesce(oa.total_orders, 0) >= p_min_orders
      and coalesce(oa.total_spent_cents, 0) >= p_min_spent_cents
  ),
  -- CTE 4: pagina com cursor. Ordena por last_order_at DESC NULLS LAST
  -- (cold leads no final quando p_has_orders=false) + contact_id DESC pra
  -- determinismo na paginacao.
  page_raw as (
    select f.*
      from filtered f
     where
       p_cursor is null
       or (
         p_has_orders = true
         and not v_cursor_is_cold
         and (f.last_order_at, f.contact_id) < (v_cursor_ts, v_cursor_id)
       )
       or (
         p_has_orders = false
         and v_cursor_is_cold
         and f.last_order_at is null
         and f.contact_id < v_cursor_id
       )
     order by
       case when p_has_orders then f.last_order_at end desc nulls last,
       f.contact_id desc
     limit v_limit + 1
  ),
  page as (
    select * from page_raw limit v_limit
  ),
  has_more as (
    select count(*) > v_limit as more from page_raw
  ),
  last_row as (
    select contact_id,
           coalesce(last_order_at::text, 'cold') as cursor_ts_part
      from page
     order by
       case when p_has_orders then last_order_at end asc nulls first,
       contact_id asc
     limit 1
  )
  select
    coalesce(jsonb_agg(row_to_json(p)), '[]'::jsonb),
    case
      when (select more from has_more) then
        replace(
          encode(convert_to(
            (select cursor_ts_part from last_row) || '|' || (select contact_id::text from last_row),
            'UTF8'
          ), 'base64'),
          E'\n',
          ''
        )
      else null
    end
    into v_candidates, v_next_cursor
    from (
      select
        page.contact_id,
        page.display_name,
        page.phone_number,
        page.last_activity_at,
        coalesce(page.tags, '{}'::text[]) as tags,
        page.has_marketing_consent,
        page.total_orders,
        page.total_spent_cents,
        case
          when page.total_orders = 0 then 0
          else round(page.total_spent_cents::numeric / page.total_orders::numeric)::bigint
        end as avg_ticket_cents,
        page.last_order_at,
        page.last_order_id,
        page.days_since_last_order,
        -- last_order_items resumido (ate 10 itens do ultimo pedido)
        (
          select coalesce(jsonb_agg(row_to_json(li)), '[]'::jsonb)
            from (
              select
                foi.product_name_snapshot as product_name,
                foi.quantity,
                foi.line_total_cents,
                foi.unit_price_cents,
                foi.selected_modifiers
                from public.food_order_items foi
               where foi.organization_id = p_org
                 and foi.order_id = page.last_order_id
               order by foi.created_at
               limit 10
            ) li
        ) as last_order_items,
        -- favorite_products top-5 do contato (mesma logica do RPC 0176)
        (
          select coalesce(jsonb_agg(row_to_json(p2)), '[]'::jsonb)
            from (
              select
                foi.product_name_snapshot as product_name,
                sum(foi.quantity)::int as quantity,
                count(distinct foi.order_id)::int as order_count
                from public.food_order_items foi
                join public.orders o on o.id = foi.order_id and o.organization_id = foi.organization_id
               where foi.organization_id = p_org
                 and o.contact_id = page.contact_id
                 and o.status = any(v_statuses)
               group by foi.product_name_snapshot
               order by quantity desc, order_count desc, foi.product_name_snapshot asc
               limit 5
            ) p2
        ) as favorite_products,
        -- last_order_external_id/provider do ultimo pedido (pra nutrir copy)
        (
          select jsonb_build_object(
            'external_id', o.external_id,
            'external_provider', o.external_provider,
            'status', o.status,
            'total_cents', o.total_cents,
            'currency', coalesce(o.currency, 'BRL')
          )
            from public.orders o
           where o.id = page.last_order_id
             and o.organization_id = p_org
        ) as last_order_meta
      from page
    ) p;

  return jsonb_build_object(
    'candidates', v_candidates,
    'next_cursor', v_next_cursor,
    'inactive_days', p_inactive_days,
    'min_orders', p_min_orders,
    'min_spent_cents', p_min_spent_cents,
    'has_orders', p_has_orders,
    'queried_at', p_now
  );
end;
$$;

-- ACL: revoke das duas origens (issue #128).
revoke execute on function public.fn_customers_by_purchase_recency(
  uuid, int, int, bigint, text, int, text, boolean, timestamptz
) from public, anon, authenticated;
grant execute on function public.fn_customers_by_purchase_recency(
  uuid, int, int, bigint, text, int, text, boolean, timestamptz
) to authenticated, service_role;

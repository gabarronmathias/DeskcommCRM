create or replace function public.fn_food_delivery_report(
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'metrics_period_invalid' using errcode='22023';
  end if;
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode='42501';
  end if;
  if not (public.fn_role_at_least(p_organization_id,'agent') or public.fn_is_platform_admin()) then
    raise exception 'caller_not_authorized_for_org' using errcode='42501';
  end if;

  with eligible_contacts as (
    select c.id
    from public.contacts c
    where c.organization_id=p_organization_id
      and coalesce(c.is_anonymized,false)=false
      and not ('demo'=any(coalesce(c.tags,array[]::text[])))
      and coalesce(c.phone_number,'') !~ '^\\+?0{4}'
  ),
  sarah_activity as (
    select
      count(*)::bigint as messages_sent,
      count(distinct m.contact_id)::bigint as contacts_served,
      count(*) filter (
        where coalesce((m.metadata->>'food_upsell_applied')::boolean,false)=true
      )::bigint as upsell_offers
    from public.messages m
    join eligible_contacts ec on ec.id=m.contact_id
    where m.organization_id=p_organization_id
      and m.direction='outbound'
      and m.sent_via='ai'
      and m.created_at>=p_from and m.created_at<p_to
      and m.status<>'failed'
  ),
  period_orders as (
    select o.*
    from public.orders o
    join eligible_contacts ec on ec.id=o.contact_id
    where o.organization_id=p_organization_id
      and o.external_provider='deskcomm_food'
      and o.ordered_at>=p_from and o.ordered_at<p_to
      and o.status<>'cancelled'
  ),
  order_summary as (
    select
      count(*)::bigint as orders_count,
      coalesce(sum(o.total_cents),0)::bigint as gross_revenue_cents,
      coalesce(round(avg(o.total_cents)),0)::bigint as average_ticket_cents
    from period_orders o
  ),
  upsell_sales as (
    select
      count(distinct oi.order_id)::bigint as orders_with_upsell,
      coalesce(sum(oi.quantity),0)::bigint as upsell_items_sold,
      coalesce(sum(oi.line_total_cents),0)::bigint as upsell_revenue_cents
    from public.food_order_items oi
    join period_orders o on o.id=oi.order_id
    where oi.organization_id=p_organization_id
      and oi.added_via_recommendation=true
  ),
  queue_touches as (
    select
      j.contact_id,
      j.created_at as touch_at,
      case
        when j.payload->>'food_flow_name'='Campanhas na base' then 'campaign'
        when j.payload->>'food_automation'='manual_flow_fallback_v1'
             and j.payload->>'food_flow_name'='Campanhas na base' then 'campaign'
        when j.payload->>'food_automation'='cart_recovery_v1' then 'recovery'
        when j.payload->>'food_automation'='silence_followup_v1'
             and coalesce((j.payload->>'food_order_context')::boolean,false)=true then 'recovery'
        else null
      end as touch_kind
    from public.job_queue j
    join eligible_contacts ec on ec.id=j.contact_id
    where j.organization_id=p_organization_id
      and j.kind='followup_turn'
      and j.status='done'
      and j.created_at>=p_from-interval '24 hours' and j.created_at<p_to
  ),
  flow_touches as (
    select
      fe.contact_id,
      coalesce(fe.completed_at,fe.updated_at,fe.started_at) as touch_at,
      case
        when fp.name='Campanhas na base' then 'campaign'
        when fp.name='Recuperação de carrinho' then 'recovery'
        else null
      end as touch_kind
    from public.followup_enrollments fe
    join public.followup_flow_pointers fp
      on fp.id=fe.pointer_id and fp.organization_id=fe.organization_id
    join eligible_contacts ec on ec.id=fe.contact_id
    where fe.organization_id=p_organization_id
      and fp.name in ('Campanhas na base','Recuperação de carrinho')
      and fe.steps_taken>0
      and coalesce(fe.completed_at,fe.updated_at,fe.started_at)>=p_from-interval '24 hours'
      and coalesce(fe.completed_at,fe.updated_at,fe.started_at)<p_to
  ),
  touches as (
    select * from queue_touches where touch_kind is not null
    union all
    select * from flow_touches where touch_kind is not null
  ),
  touch_counts as (
    select
      count(*) filter (where touch_kind='campaign' and touch_at>=p_from and touch_at<p_to)::bigint as campaigns_sent,
      count(*) filter (where touch_kind='recovery' and touch_at>=p_from and touch_at<p_to)::bigint as recoveries_sent,
      count(distinct contact_id) filter (where touch_kind='campaign' and touch_at>=p_from and touch_at<p_to)::bigint as campaign_contacts,
      count(distinct contact_id) filter (where touch_kind='recovery' and touch_at>=p_from and touch_at<p_to)::bigint as recovery_contacts
    from touches
  ),
  attributed_orders as (
    select
      o.id,o.total_cents,
      t.touch_kind
    from period_orders o
    left join lateral (
      select x.touch_kind,x.touch_at
      from touches x
      where x.contact_id=o.contact_id
        and x.touch_at<=o.ordered_at
        and x.touch_at>=o.ordered_at-interval '24 hours'
      order by x.touch_at desc
      limit 1
    ) t on true
  ),
  attribution as (
    select
      coalesce(sum(total_cents) filter (where touch_kind='campaign'),0)::bigint as campaign_revenue_cents,
      coalesce(sum(total_cents) filter (where touch_kind='recovery'),0)::bigint as recovery_revenue_cents,
      count(*) filter (where touch_kind='campaign')::bigint as campaign_orders,
      count(*) filter (where touch_kind='recovery')::bigint as recovered_orders
    from attributed_orders
  ),
  influenced as (
    select coalesce(sum(o.total_cents),0)::bigint as sarah_influenced_revenue_cents
    from period_orders o
    where exists (
      select 1 from touches t
      where t.contact_id=o.contact_id
        and t.touch_at<=o.ordered_at
        and t.touch_at>=o.ordered_at-interval '24 hours'
    )
    or exists (
      select 1 from public.food_order_items oi
      where oi.order_id=o.id and oi.organization_id=p_organization_id
        and oi.added_via_recommendation=true
    )
  )
  select jsonb_build_object(
    'period',jsonb_build_object('from',p_from,'to',p_to),
    'sarah',jsonb_build_object(
      'contacts_served',sa.contacts_served,
      'messages_sent',sa.messages_sent
    ),
    'delivery',jsonb_build_object(
      'orders_count',os.orders_count,
      'gross_revenue_cents',os.gross_revenue_cents,
      'average_ticket_cents',os.average_ticket_cents
    ),
    'upsell',jsonb_build_object(
      'offers',sa.upsell_offers,
      'orders_with_upsell',us.orders_with_upsell,
      'items_sold',us.upsell_items_sold,
      'revenue_cents',us.upsell_revenue_cents
    ),
    'campaigns',jsonb_build_object(
      'sent',tc.campaigns_sent,
      'contacts',tc.campaign_contacts,
      'orders',a.campaign_orders,
      'revenue_cents',a.campaign_revenue_cents
    ),
    'recoveries',jsonb_build_object(
      'sent',tc.recoveries_sent,
      'contacts',tc.recovery_contacts,
      'orders',a.recovered_orders,
      'revenue_cents',a.recovery_revenue_cents
    ),
    'sarah_influenced_revenue_cents',i.sarah_influenced_revenue_cents
  ) into v_result
  from sarah_activity sa,order_summary os,upsell_sales us,touch_counts tc,attribution a,influenced i;

  return v_result;
end;
$function$;

revoke all on function public.fn_food_delivery_report(uuid,timestamptz,timestamptz) from public;
revoke all on function public.fn_food_delivery_report(uuid,timestamptz,timestamptz) from anon;
grant execute on function public.fn_food_delivery_report(uuid,timestamptz,timestamptz) to authenticated;

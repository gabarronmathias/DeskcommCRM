-- Paridade comercial entre Capri e Chopperia: upsell persuasivo, recuperação em 3 minutos,
-- follow-up para contatos reais e campanhas/reativação com memória do último pedido.

create or replace function public.fn_food_append_deterministic_upsell()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_inbound_body text;
  v_trigger_product_id uuid;
  v_trigger_name text;
  v_score real;
  v_recommended_name text;
  v_recommended_price bigint;
  v_rule_id uuid;
begin
  if new.direction <> 'outbound' or new.sent_via <> 'ai' or new.body is null
     or not coalesce((new.metadata->>'deterministic_food_rule')::boolean,false)
     or coalesce((new.metadata->>'food_upsell_applied')::boolean,false) then return new; end if;
  if not exists(select 1 from public.food_commerce_settings f where f.organization_id=new.organization_id and f.is_enabled=true) then return new; end if;
  if nullif(new.metadata->>'origin_inbound_message_id','') is null then return new; end if;

  select m.body into v_inbound_body
  from public.messages m
  where m.id=(new.metadata->>'origin_inbound_message_id')::uuid
    and m.organization_id=new.organization_id and m.direction='inbound';
  if v_inbound_body is null then return new; end if;

  select p.id,p.name,
         greatest(word_similarity(lower(p.name),lower(v_inbound_body)),similarity(lower(p.name),lower(v_inbound_body)))::real
    into v_trigger_product_id,v_trigger_name,v_score
  from public.food_products p
  where p.organization_id=new.organization_id and p.is_available=true
  order by greatest(word_similarity(lower(p.name),lower(v_inbound_body)),similarity(lower(p.name),lower(v_inbound_body))) desc,p.sort_order,p.name
  limit 1;
  if v_trigger_product_id is null or coalesce(v_score,0)<0.55 then return new; end if;

  select r.id,rp.name,rp.price_cents
    into v_rule_id,v_recommended_name,v_recommended_price
  from public.food_recommendation_rules r
  join public.food_products rp on rp.id=r.recommended_product_id and rp.organization_id=r.organization_id
  where r.organization_id=new.organization_id and r.is_active=true and r.trigger_product_id=v_trigger_product_id
    and r.recommended_product_id is not null and r.kind in ('upsell','cross_sell','upgrade','combo','order_bump')
    and rp.is_available=true
  order by r.priority,r.created_at limit 1;
  if v_recommended_name is null or v_recommended_price is null then return new; end if;
  if position(lower(v_recommended_name) in lower(new.body))>0 then return new; end if;

  new.body:=rtrim(new.body)||E'\n\n'||'Aproveitando sua escolha: '||v_trigger_name||' combina muito bem com '||v_recommended_name||'. Por só R$ '||replace(to_char(v_recommended_price/100.0,'FM999999990D00'),'.',',')||' a mais, seu pedido fica mais completo. Quer que eu já inclua para você? 😊';
  new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object('food_upsell_applied',true,'food_upsell_rule_id',v_rule_id);
  return new;
end;
$function$;

create or replace function public.fn_food_cancel_recovery_on_order_created()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.external_provider is distinct from 'deskcomm_food' or new.contact_id is null
     or not exists(select 1 from public.food_commerce_settings f where f.organization_id=new.organization_id and f.is_enabled=true) then return new; end if;
  update public.cron_jobs
     set enabled=false,cancelled_at=coalesce(cancelled_at,now()),cancel_reason=coalesce(cancel_reason,'pedido concluído no cardápio'),updated_at=now()
   where organization_id=new.organization_id and contact_id=new.contact_id and enabled=true
     and payload->>'food_automation' in ('cart_recovery_v1','silence_followup_v1');
  update public.followup_enrollments e
     set status='cancelled',next_eval_at=null,claimed_until=null,cancel_reason=coalesce(e.cancel_reason,'pedido concluído no cardápio'),updated_at=now()
    from public.followup_flow_pointers p
   where e.pointer_id=p.id and e.organization_id=new.organization_id and e.contact_id=new.contact_id
     and e.status in ('active','waiting_reply','paused_handoff','paused_manual')
     and p.organization_id=new.organization_id and p.name in ('Recuperação de carrinho','Follow-up automático');
  return new;
end;
$function$;

create or replace function public.fn_food_demo_manage_silence_followup()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org_slug text; v_is_eligible boolean:=false; v_can_send boolean:=false;
  v_latest_inbound text; v_is_order_context boolean:=false;
  v_delay interval:=interval '5 minutes'; v_delay_label text:='5 minutos';
begin
  select o.slug into v_org_slug from public.organizations o where o.id=new.organization_id;
  if v_org_slug not in ('capri','chopperia-do-gordo') then return new; end if;
  if new.contact_id is null or new.is_group=true or new.last_inbound_at is null then return new; end if;
  if tg_op='UPDATE' and old.last_inbound_at is not distinct from new.last_inbound_at then return new; end if;

  update public.cron_jobs set enabled=false,cancelled_at=coalesce(cancelled_at,now()),cancel_reason=coalesce(cancel_reason,'cliente voltou a responder'),updated_at=now()
  where organization_id=new.organization_id and contact_id=new.contact_id and enabled=true and payload->>'food_automation'='cart_recovery_v1';

  select coalesce(c.is_blocked,false)=false and coalesce(c.force_human,false)=false and coalesce(c.is_anonymized,false)=false and c.is_merged_into is null
    into v_is_eligible
  from public.contacts c where c.id=new.contact_id and c.organization_id=new.organization_id;
  select exists(select 1 from public.channel_sessions cs where cs.id=new.channel_session_id and cs.organization_id=new.organization_id and cs.status='WORKING' and cs.archived_at is null)
    into v_can_send;

  update public.cron_jobs set enabled=false,cancelled_at=coalesce(cancelled_at,now()),cancel_reason=coalesce(cancel_reason,'substituído por nova mensagem inbound'),updated_at=now()
  where organization_id=new.organization_id and contact_id=new.contact_id and enabled=true and payload->>'food_automation'='silence_followup_v1';
  if not coalesce(v_is_eligible,false) or not coalesce(v_can_send,false) then return new; end if;

  select m.body into v_latest_inbound
  from public.messages m
  where m.organization_id=new.organization_id and m.conversation_id=new.id and m.contact_id=new.contact_id and m.direction='inbound' and m.body is not null
  order by m.created_at desc limit 1;

  v_is_order_context:=coalesce(v_latest_inbound,'') ~* '(pedido|compr|quero|adicion|inclu|carrinho|card[aá]pio|menu|quantidade|unidade)'
    or exists(select 1 from public.food_products p where p.organization_id=new.organization_id and p.is_available=true
      and greatest(word_similarity(lower(p.name),lower(coalesce(v_latest_inbound,''))),similarity(lower(p.name),lower(coalesce(v_latest_inbound,''))))>=0.55);
  if v_is_order_context then v_delay:=interval '3 minutes'; v_delay_label:='3 minutos'; end if;

  insert into public.cron_jobs(organization_id,contact_id,kind,tz,job_kind,payload,next_run_at,enabled,max_attempts)
  values(new.organization_id,new.contact_id,'at','America/Sao_Paulo','followup_turn',jsonb_build_object(
    'mode','agent',
    'reason',case when v_is_order_context then 'Recuperação automática de venda: o cliente estava em contexto de pedido/produto e ficou sem responder por cerca de '||v_delay_label||'. Faça UMA retomada curta, natural e altamente persuasiva para ajudá-lo a concluir. Retome exatamente o interesse demonstrado, reduza atrito e faça uma pergunta simples de fechamento. Se houver uma oportunidade real, ofereça UM complemento relevante do catálogo. Não invente desconto, promoção, produto ou preço.' else 'Follow-up automático: o cliente iniciou atendimento e ficou sem responder por cerca de '||v_delay_label||'. Faça UMA retomada curta, útil e sem pressão. Não diga que havia uma promessa ou horário combinado.' end,
    'context_snapshot',case when v_is_order_context then 'O cliente estava avançando em uma compra. Retome do ponto em que parou, preserve o contexto e facilite a conclusão. Se citar item/preço, consulte dados reais do catálogo.' else 'Retome a conversa do ponto em que parou e ajude o cliente a avançar no atendimento. Se ele já recusou, pediu para parar ou houve handoff humano, não envie nova abordagem.' end,
    'food_automation','silence_followup_v1','food_order_context',v_is_order_context,'conversation_id',new.id),now()+v_delay,true,3);
  return new;
end;
$function$;

create or replace function public.fn_food_demo_schedule_cart_recovery()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_org_slug text; v_abandoned_stage uuid; v_can_send boolean; v_delay interval:=interval '3 minutes'; v_delay_label text:='3 minutos';
begin
  select o.slug into v_org_slug from public.organizations o where o.id=new.organization_id;
  if v_org_slug not in ('capri','chopperia-do-gordo') then return new; end if;
  select s.id into v_abandoned_stage from public.crm_stages s join public.crm_pipelines p on p.id=s.pipeline_id
  where p.organization_id=new.organization_id and s.slug='carrinho_abandonado' and coalesce(s.is_archived,false)=false order by s.position limit 1;
  if tg_op='UPDATE' and old.stage_id is distinct from new.stage_id and old.stage_id=v_abandoned_stage and new.stage_id is distinct from v_abandoned_stage then
    update public.cron_jobs set enabled=false,cancelled_at=coalesce(cancelled_at,now()),cancel_reason=coalesce(cancel_reason,'lead deixou Carrinho abandonado'),updated_at=now()
    where organization_id=new.organization_id and contact_id=new.contact_id and enabled=true and payload->>'food_automation'='cart_recovery_v1'; return new; end if;
  if new.stage_id is distinct from v_abandoned_stage or (tg_op='UPDATE' and old.stage_id is not distinct from new.stage_id) or new.status<>'open' then return new; end if;
  select exists(select 1 from public.channel_sessions cs where cs.organization_id=new.organization_id and cs.status='WORKING' and cs.archived_at is null)
    and exists(select 1 from public.contacts c where c.id=new.contact_id and c.organization_id=new.organization_id and coalesce(c.is_blocked,false)=false and coalesce(c.force_human,false)=false and coalesce(c.is_anonymized,false)=false and c.is_merged_into is null)
    into v_can_send;
  if not coalesce(v_can_send,false) then return new; end if;
  update public.cron_jobs set enabled=false,cancelled_at=coalesce(cancelled_at,now()),cancel_reason=coalesce(cancel_reason,'substituído por recuperação mais recente'),updated_at=now()
  where organization_id=new.organization_id and contact_id=new.contact_id and enabled=true and payload->>'food_automation'='cart_recovery_v1';
  insert into public.cron_jobs(organization_id,contact_id,kind,tz,job_kind,payload,next_run_at,enabled,max_attempts)
  values(new.organization_id,new.contact_id,'at','America/Sao_Paulo','followup_turn',jsonb_build_object(
    'mode','agent','reason','Recuperação automática: o cliente deixou um pedido no carrinho e não concluiu há cerca de 3 minutos. Faça UMA retomada curta, natural e altamente persuasiva para recuperar a venda. Mostre que concluir é fácil, retome o interesse pelo pedido e crie vontade de finalizar sem pressionar. Se houver oportunidade real, ofereça UM complemento relevante do catálogo. Não invente desconto, produto, preço ou promoção.',
    'context_snapshot','Carrinho abandonado. Retome do ponto em que a conversa parou, preserve o pedido já montado e facilite a conclusão. Se fizer sentido, reforce em uma frase o valor/conveniência do que o cliente já escolheu e faça uma pergunta simples de fechamento. Se precisar citar item/preço, consulte as ferramentas disponíveis.',
    'food_automation','cart_recovery_v1','crm_lead_id',new.id),now()+v_delay,true,3);
  return new;
end;
$function$;

create or replace function public.fn_food_demo_schedule_manual_flow_fallback()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org_slug text; v_pointer_name text; v_reason text; v_context text; v_can_send boolean:=false;
  v_last_order_id uuid; v_last_order_at timestamptz; v_last_total bigint; v_last_items text; v_last_order_context text;
begin
  select o.slug into v_org_slug from public.organizations o where o.id=new.organization_id;
  if v_org_slug not in ('capri','chopperia-do-gordo') then return new; end if;
  select name into v_pointer_name from public.followup_flow_pointers where id=new.pointer_id and organization_id=new.organization_id and status='active';
  if v_pointer_name not in ('Reativação de clientes','Campanhas na base') then return new; end if;
  select exists(select 1 from public.contacts c where c.id=new.contact_id and c.organization_id=new.organization_id and coalesce(c.is_blocked,false)=false and coalesce(c.force_human,false)=false and coalesce(c.is_anonymized,false)=false and c.is_merged_into is null)
    and exists(select 1 from public.channel_sessions cs where cs.organization_id=new.organization_id and cs.status='WORKING' and cs.archived_at is null) into v_can_send;
  if not coalesce(v_can_send,false) then return new; end if;

  select o.id,o.ordered_at,o.total_cents into v_last_order_id,v_last_order_at,v_last_total
  from public.orders o
  where o.organization_id=new.organization_id and o.contact_id=new.contact_id and o.external_provider='deskcomm_food' and o.status<>'cancelled'
  order by o.ordered_at desc nulls last,o.created_at desc limit 1;
  if v_last_order_id is not null then
    select string_agg(oi.quantity::text||'x '||oi.product_name_snapshot,', ' order by oi.created_at,oi.product_name_snapshot)
      into v_last_items
    from public.food_order_items oi where oi.organization_id=new.organization_id and oi.order_id=v_last_order_id;
    v_last_order_context:='Último pedido confirmado: '||coalesce(v_last_items,'itens não detalhados')||', total R$ '||replace(to_char(coalesce(v_last_total,0)/100.0,'FM999999990D00'),'.',',')||', realizado em '||to_char(v_last_order_at at time zone 'America/Sao_Paulo','DD/MM/YYYY')||'. ';
  else
    v_last_order_context:='Não há pedido concluído identificado para este contato no checkout Deskcomm. ';
  end if;

  if v_pointer_name='Reativação de clientes' then
    v_reason:='Reativação comercial. Faça UMA mensagem curta, humana e muito persuasiva para gerar uma nova compra. Se houver último pedido, use-o naturalmente para demonstrar memória e relevância. Em seguida, procure uma oportunidade real de vender MAIS: consulte o catálogo e ofereça UM produto complementar, upgrade ou nova opção coerente com o histórico. Nunca invente desconto, promoção, produto, preço, estoque ou benefício.';
    v_context:=v_last_order_context||'Não transforme a mensagem em spam. O objetivo é lembrar a preferência do cliente e criar um próximo pedido maior e relevante.';
  else
    v_reason:='Campanha comercial personalizada. Faça UMA mensagem curta, humana e muito persuasiva para gerar nova compra. Se houver último pedido, mencione-o naturalmente. Depois, não se limite a repetir o pedido: consulte o catálogo e ofereça UM complemento, upgrade ou produto adicional realmente compatível para aumentar o ticket. Nunca invente promoção, desconto, preço, estoque ou benefício.';
    v_context:=v_last_order_context||'Use o histórico como memória comercial e o catálogo atual como fonte de verdade. Evite linguagem genérica de disparo em massa.';
  end if;

  insert into public.cron_jobs(organization_id,contact_id,kind,tz,job_kind,payload,next_run_at,enabled,max_attempts)
  values(new.organization_id,new.contact_id,'at','America/Sao_Paulo','followup_turn',jsonb_build_object(
    'mode','agent','reason',v_reason,'context_snapshot',v_context,'food_automation','manual_flow_fallback_v1',
    'food_flow_name',v_pointer_name,'food_enrollment_ref',new.id,'last_order_id',v_last_order_id),now()+interval '20 seconds',true,3);
  return new;
end;
$function$;

-- Recovery flow: 3 minutos nas duas operações.
with targets as (
  select fv.id,fv.graph
  from public.followup_flow_versions fv
  join public.followup_flow_pointers fp on fp.active_version_id=fv.id
  join public.organizations o on o.id=fp.organization_id
  where o.slug in ('capri','chopperia-do-gordo') and fp.name='Recuperação de carrinho' and fp.status='active'
), rewritten as (
  select t.id,jsonb_set(t.graph,'{nodes}',(
    select jsonb_agg(case when n->>'id'='wait' then
      jsonb_set(jsonb_set(n,'{label}',to_jsonb('Aguardar 3 minutos'::text),false),'{config,duration_ms}',to_jsonb(180000::int),false)
      else n end)
    from jsonb_array_elements(t.graph->'nodes') n
  ),false) new_graph from targets t
)
update public.followup_flow_versions fv set graph=r.new_graph from rewritten r where fv.id=r.id;

-- Campanhas e reativação: memória do último pedido + venda adicional relevante.
with targets as (
  select fv.id,fv.graph,fp.name
  from public.followup_flow_versions fv
  join public.followup_flow_pointers fp on fp.active_version_id=fv.id
  join public.organizations o on o.id=fp.organization_id
  where o.slug in ('capri','chopperia-do-gordo') and fp.name in ('Campanhas na base','Reativação de clientes') and fp.status='active'
), rewritten as (
  select t.id,jsonb_set(t.graph,'{nodes}',(
    select jsonb_agg(case when n->>'id'='action' then
      jsonb_set(n,'{config,prompt_hint}',to_jsonb(case when t.name='Campanhas na base' then
        'Envie uma mensagem comercial curta, humana, personalizada e muito persuasiva para gerar nova compra. Use o histórico do cliente. Se houver último pedido, relembre-o naturalmente para demonstrar memória. Depois, não se limite a repetir: ofereça UM produto adicional, complemento ou upgrade realmente compatível, consultando somente o catálogo atual. Nunca invente promoção, desconto, preço, estoque, escassez ou benefício. Evite texto genérico de disparo em massa e respeite opt-out.'
      else
        'Reative este cliente com uma mensagem curta, humana e muito persuasiva. Se houver último pedido, relembre-o naturalmente. Em seguida, procure uma oportunidade real de vender MAIS oferecendo UM complemento, upgrade ou produto adicional coerente com o histórico e com o catálogo atual. Nunca invente promoção, desconto, preço, estoque, escassez ou benefício. Não pareça spam e respeite opt-out.' end),true)
      else n end)
    from jsonb_array_elements(t.graph->'nodes') n
  ),false) new_graph from targets t
)
update public.followup_flow_versions fv set graph=r.new_graph from rewritten r where fv.id=r.id;
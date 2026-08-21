create or replace function public.fn_food_conversation_ai_available(p_org uuid,p_conversation uuid,p_contact uuid)
returns boolean
language sql
stable
security invoker
set search_path to 'public'
as $function$
  select exists(
    select 1
    from public.conversations c
    where c.id=p_conversation
      and c.organization_id=p_org
      and c.contact_id=p_contact
      and c.is_group=false
      and (c.bot_silenced_until is null or c.bot_silenced_until<=now())
  );
$function$;

revoke all on function public.fn_food_conversation_ai_available(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_food_conversation_ai_available(uuid,uuid,uuid) to service_role;

create or replace function public.fn_food_sarah_opening_v2_on_inbound()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org_name text; v_slug text; v_tz text; v_contact_name text; v_hour int; v_period text; v_opening text;
  v_blocked boolean:=false; v_force_human boolean:=false; v_anonymized boolean:=false; v_day date;
begin
  if new.direction<>'inbound' or new.contact_id is null or new.conversation_id is null or new.channel_session_id is null then return new; end if;
  if not exists(select 1 from public.food_commerce_settings f where f.organization_id=new.organization_id and f.is_enabled=true) then return new; end if;
  if not public.fn_food_conversation_ai_available(new.organization_id,new.conversation_id,new.contact_id) then return new; end if;
  if not exists(select 1 from public.channel_sessions s where s.id=new.channel_session_id and s.organization_id=new.organization_id and s.status='WORKING' and s.archived_at is null) then return new; end if;

  select coalesce(c.is_blocked,false),coalesce(c.force_human,false),coalesce(c.is_anonymized,false),nullif(btrim(split_part(c.display_name,' ',1)),'')
  into v_blocked,v_force_human,v_anonymized,v_contact_name
  from public.contacts c where c.id=new.contact_id and c.organization_id=new.organization_id;
  if v_blocked or v_force_human or v_anonymized then return new; end if;
  if v_contact_name ~ '^[+0-9(). -]+$' then v_contact_name:=null; end if;

  select coalesce(nullif(f.app_name,''),o.display_name),o.slug,coalesce(nullif(o.timezone,''),'America/Sao_Paulo')
  into v_org_name,v_slug,v_tz
  from public.organizations o left join public.food_commerce_settings f on f.organization_id=o.id
  where o.id=new.organization_id;
  if v_slug is null then return new; end if;

  v_day := (coalesce(new.sent_at,new.created_at,now()) at time zone v_tz)::date;
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text||':'||new.contact_id::text||':'||v_day::text,0));

  if exists(
    select 1 from public.messages m
    where m.organization_id=new.organization_id and m.contact_id=new.contact_id
      and m.direction='outbound' and m.sent_via='ai' and m.status<>'failed'
      and m.created_at < coalesce(new.created_at,now())
      and (m.created_at at time zone v_tz)::date=v_day
  ) then return new; end if;

  v_hour:=extract(hour from (coalesce(new.sent_at,new.created_at,now()) at time zone v_tz));
  v_period:=case when v_hour between 5 and 11 then 'bom dia' when v_hour between 12 and 17 then 'boa tarde' else 'boa noite' end;
  v_opening:='Olá, '||v_period||coalesce(', '||v_contact_name,'')||'! 😊'||E'\n\n'||
    'Muito obrigado por ter entrado em contato com a '||v_org_name||'.'||E'\n\n'||
    'Meu nome é Sarah e vou te atender por aqui. Como posso te ajudar hoje?'||E'\n\n'||
    'Para acessar nosso cardápio digital, basta acessar o link abaixo:'||E'\n'||
    'https://gabarronmathias.github.io/DeskcommCRM/'||v_slug||'/';

  insert into public.messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at,metadata,created_at)
  select new.organization_id,new.conversation_id,new.channel_session_id,new.contact_id,'text','outbound','queued',v_opening,'ai',now(),
    jsonb_build_object('ai_actor_id','agent-engine-opening-v2','sarah_opening_v2',true,'deterministic_food_early',true,'reactive_outbox',true,'origin_inbound_message_id',new.id::text),now()
  where not exists(select 1 from public.messages existing where existing.organization_id=new.organization_id and existing.metadata->>'origin_inbound_message_id'=new.id::text and coalesce((existing.metadata->>'reactive_outbox')::boolean,false)=true);
  return new;
end;
$function$;

create or replace function public.fn_food_deterministic_on_inbound()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reply text;
  v_contact_blocked boolean := false;
  v_contact_force_human boolean := false;
  v_contact_anonymized boolean := false;
begin
  if new.direction <> 'inbound' or new.contact_id is null or new.conversation_id is null or new.channel_session_id is null then return new; end if;
  if not exists(select 1 from public.food_commerce_settings f where f.organization_id=new.organization_id and f.is_enabled=true) then return new; end if;
  if not public.fn_food_conversation_ai_available(new.organization_id,new.conversation_id,new.contact_id) then return new; end if;
  if not exists(select 1 from public.channel_sessions s where s.id=new.channel_session_id and s.organization_id=new.organization_id and s.status='WORKING' and s.archived_at is null) then return new; end if;

  select coalesce(c.is_blocked,false),coalesce(c.force_human,false),coalesce(c.is_anonymized,false)
    into v_contact_blocked,v_contact_force_human,v_contact_anonymized
  from public.contacts c where c.id=new.contact_id and c.organization_id=new.organization_id;
  if v_contact_blocked or v_contact_force_human or v_contact_anonymized then return new; end if;

  v_reply:=public.fn_food_deterministic_reply(new.organization_id,new.conversation_id,new.id);
  if v_reply is null then return new; end if;

  insert into public.messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at,metadata,created_at)
  select new.organization_id,new.conversation_id,new.channel_session_id,new.contact_id,
    'text','outbound','queued',v_reply,'ai',now(),
    jsonb_build_object('ai_actor_id','agent-engine-deterministic-early','deterministic_food_rule',true,'deterministic_food_early',true,'reactive_outbox',true,'origin_inbound_message_id',new.id::text),
    now()-interval '2 minutes'
  where not exists(select 1 from public.messages existing where existing.organization_id=new.organization_id and existing.metadata->>'origin_inbound_message_id'=new.id::text and coalesce((existing.metadata->>'reactive_outbox')::boolean,false)=true);
  return new;
end;
$function$;

create or replace function public.fn_food_fast_enqueue_inbound()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_blocked boolean:=false; v_force_human boolean:=false; v_anonymized boolean:=false;
begin
  if new.direction<>'inbound' or new.contact_id is null or new.conversation_id is null or new.channel_session_id is null or new.body is null
     or not exists(select 1 from public.food_commerce_settings f where f.organization_id=new.organization_id and f.is_enabled=true) then return new; end if;
  if exists(select 1 from public.messages m where m.organization_id=new.organization_id and m.metadata->>'origin_inbound_message_id'=new.id::text and coalesce((m.metadata->>'reactive_outbox')::boolean,false)) then return new; end if;
  if not public.fn_food_conversation_ai_available(new.organization_id,new.conversation_id,new.contact_id) then return new; end if;
  if not exists(select 1 from public.channel_sessions s where s.id=new.channel_session_id and s.organization_id=new.organization_id and s.status='WORKING' and s.archived_at is null) then return new; end if;

  select coalesce(c.is_blocked,false),coalesce(c.force_human,false),coalesce(c.is_anonymized,false)
    into v_blocked,v_force_human,v_anonymized
  from public.contacts c where c.id=new.contact_id and c.organization_id=new.organization_id;
  if v_blocked or v_force_human or v_anonymized then return new; end if;

  insert into public.job_queue(organization_id,contact_id,kind,source_event_id,payload,status,priority,run_after,max_attempts)
  select new.organization_id,new.contact_id,'inbound_turn',null,
    jsonb_build_object('v',1,'crm_event_id',new.id::text,'event_type','message.received','conversation_id',new.conversation_id::text,'contact_id',new.contact_id::text,'channel_session_id',new.channel_session_id::text,'inbound_message_id',new.id::text,'channel','whatsapp','source','db_fast_path'),
    'pending',20,clock_timestamp()+interval '250 milliseconds',2
  where not exists(select 1 from public.job_queue j where j.organization_id=new.organization_id and j.kind='inbound_turn' and j.payload->>'inbound_message_id'=new.id::text);
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
  v_org_slug text; v_is_eligible boolean:=false; v_can_send boolean:=false; v_latest_inbound text; v_is_order_context boolean:=false;
  v_delay interval:=interval '5 minutes'; v_delay_label text:='5 minutos';
begin
  select o.slug into v_org_slug from public.organizations o where o.id=new.organization_id;
  if v_org_slug not in ('capri','chopperia-do-gordo') then return new; end if;
  if new.contact_id is null or new.is_group=true or new.last_inbound_at is null then return new; end if;
  if tg_op='UPDATE' and old.last_inbound_at is not distinct from new.last_inbound_at then return new; end if;

  update public.cron_jobs set enabled=false,cancelled_at=coalesce(cancelled_at,now()),cancel_reason=coalesce(cancel_reason,'cliente voltou a responder'),updated_at=now()
  where organization_id=new.organization_id and contact_id=new.contact_id and enabled=true and payload->>'food_automation'='cart_recovery_v1';
  update public.cron_jobs set enabled=false,cancelled_at=coalesce(cancelled_at,now()),cancel_reason=coalesce(cancel_reason,'substituído por nova mensagem inbound'),updated_at=now()
  where organization_id=new.organization_id and contact_id=new.contact_id and enabled=true and payload->>'food_automation'='silence_followup_v1';

  if new.bot_silenced_until is not null and new.bot_silenced_until>now() then return new; end if;

  select coalesce(c.is_blocked,false)=false and coalesce(c.force_human,false)=false and coalesce(c.is_anonymized,false)=false and c.is_merged_into is null
    into v_is_eligible from public.contacts c where c.id=new.contact_id and c.organization_id=new.organization_id;
  select exists(select 1 from public.channel_sessions cs where cs.id=new.channel_session_id and cs.organization_id=new.organization_id and cs.status='WORKING' and cs.archived_at is null)
    into v_can_send;
  if not coalesce(v_is_eligible,false) or not coalesce(v_can_send,false) then return new; end if;

  select m.body into v_latest_inbound from public.messages m where m.organization_id=new.organization_id and m.conversation_id=new.id and m.contact_id=new.contact_id and m.direction='inbound' and m.body is not null order by m.created_at desc limit 1;
  v_is_order_context:=coalesce(v_latest_inbound,'') ~* '(pedido|compr|quero|adicion|inclu|carrinho|card[aá]pio|menu|quantidade|unidade)'
    or exists(select 1 from public.food_products p where p.organization_id=new.organization_id and p.is_available=true and greatest(word_similarity(lower(p.name),lower(coalesce(v_latest_inbound,''))),similarity(lower(p.name),lower(coalesce(v_latest_inbound,''))))>=0.55);
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

create or replace function public.fn_food_pause_ai_on_human_device_reply()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.direction<>'outbound' or new.sent_via<>'external_device' or new.contact_id is null or new.conversation_id is null then return new; end if;
  if not exists(select 1 from public.food_commerce_settings f where f.organization_id=new.organization_id and f.is_enabled=true) then return new; end if;

  update public.conversations c
     set bot_silenced_until=greatest(coalesce(c.bot_silenced_until,now()),now()+interval '30 minutes'),updated_at=now()
   where c.id=new.conversation_id and c.organization_id=new.organization_id and c.contact_id=new.contact_id and c.is_group=false;

  update public.cron_jobs
     set enabled=false,cancelled_at=coalesce(cancelled_at,now()),cancel_reason=coalesce(cancel_reason,'atendimento assumido manualmente no WhatsApp'),updated_at=now()
   where organization_id=new.organization_id and contact_id=new.contact_id and enabled=true
     and payload->>'food_automation' in ('cart_recovery_v1','silence_followup_v1','manual_flow_fallback_v1');

  update public.followup_enrollments e
     set status='cancelled',next_eval_at=null,claimed_until=null,cancel_reason=coalesce(e.cancel_reason,'atendimento assumido manualmente no WhatsApp'),updated_at=now()
    from public.followup_flow_pointers p
   where e.pointer_id=p.id
     and e.organization_id=new.organization_id
     and e.contact_id=new.contact_id
     and e.status in ('active','waiting_reply','paused_handoff','paused_manual')
     and p.organization_id=new.organization_id
     and p.name in ('Recuperação de carrinho','Follow-up automático','Reativação de clientes','Campanhas na base');
  return new;
end;
$function$;

create or replace function public.fn_food_demo_schedule_cart_recovery()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_org_slug text; v_abandoned_stage uuid; v_can_send boolean; v_delay interval:=interval '3 minutes';
begin
  select o.slug into v_org_slug from public.organizations o where o.id=new.organization_id;
  if v_org_slug not in ('capri','chopperia-do-gordo') then return new; end if;
  select s.id into v_abandoned_stage from public.crm_stages s join public.crm_pipelines p on p.id=s.pipeline_id where p.organization_id=new.organization_id and s.slug='carrinho_abandonado' and coalesce(s.is_archived,false)=false order by s.position limit 1;
  if tg_op='UPDATE' and old.stage_id is distinct from new.stage_id and old.stage_id=v_abandoned_stage and new.stage_id is distinct from v_abandoned_stage then
    update public.cron_jobs set enabled=false,cancelled_at=coalesce(cancelled_at,now()),cancel_reason=coalesce(cancel_reason,'lead deixou Carrinho abandonado'),updated_at=now()
    where organization_id=new.organization_id and contact_id=new.contact_id and enabled=true and payload->>'food_automation'='cart_recovery_v1'; return new; end if;
  if new.stage_id is distinct from v_abandoned_stage or (tg_op='UPDATE' and old.stage_id is not distinct from new.stage_id) or new.status<>'open' then return new; end if;
  if exists(select 1 from public.conversations c where c.organization_id=new.organization_id and c.contact_id=new.contact_id and c.is_group=false and c.bot_silenced_until>now()) then return new; end if;
  select exists(select 1 from public.channel_sessions cs where cs.organization_id=new.organization_id and cs.status='WORKING' and cs.archived_at is null)
    and exists(select 1 from public.contacts c where c.id=new.contact_id and c.organization_id=new.organization_id and coalesce(c.is_blocked,false)=false and coalesce(c.force_human,false)=false and coalesce(c.is_anonymized,false)=false and c.is_merged_into is null)
    into v_can_send;
  if not coalesce(v_can_send,false) then return new; end if;
  update public.cron_jobs set enabled=false,cancelled_at=coalesce(cancelled_at,now()),cancel_reason=coalesce(cancel_reason,'substituído por recuperação mais recente'),updated_at=now()
  where organization_id=new.organization_id and contact_id=new.contact_id and enabled=true and payload->>'food_automation'='cart_recovery_v1';
  insert into public.cron_jobs(organization_id,contact_id,kind,tz,job_kind,payload,next_run_at,enabled,max_attempts)
  values(new.organization_id,new.contact_id,'at','America/Sao_Paulo','followup_turn',jsonb_build_object('mode','agent','reason','Recuperação automática: o cliente deixou um pedido no carrinho e não concluiu há cerca de 3 minutos. Faça UMA retomada curta, natural e altamente persuasiva para recuperar a venda. Mostre que concluir é fácil, retome o interesse pelo pedido e crie vontade de finalizar sem pressionar. Se houver oportunidade real, ofereça UM complemento relevante do catálogo. Não invente desconto, produto, preço ou promoção.','context_snapshot','Carrinho abandonado. Retome do ponto em que a conversa parou, preserve o pedido já montado e facilite a conclusão. Se fizer sentido, reforce em uma frase o valor/conveniência do que o cliente já escolheu e faça uma pergunta simples de fechamento. Se precisar citar item/preço, consulte as ferramentas disponíveis.','food_automation','cart_recovery_v1','crm_lead_id',new.id),now()+v_delay,true,3);
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
  if exists(select 1 from public.conversations c where c.organization_id=new.organization_id and c.contact_id=new.contact_id and c.is_group=false and c.bot_silenced_until>now()) then return new; end if;
  select exists(select 1 from public.contacts c where c.id=new.contact_id and c.organization_id=new.organization_id and coalesce(c.is_blocked,false)=false and coalesce(c.force_human,false)=false and coalesce(c.is_anonymized,false)=false and c.is_merged_into is null)
    and exists(select 1 from public.channel_sessions cs where cs.organization_id=new.organization_id and cs.status='WORKING' and cs.archived_at is null) into v_can_send;
  if not coalesce(v_can_send,false) then return new; end if;

  select o.id,o.ordered_at,o.total_cents into v_last_order_id,v_last_order_at,v_last_total from public.orders o
  where o.organization_id=new.organization_id and o.contact_id=new.contact_id and o.external_provider='deskcomm_food' and o.status<>'cancelled'
  order by o.ordered_at desc nulls last,o.created_at desc limit 1;
  if v_last_order_id is not null then
    select string_agg(oi.quantity::text||'x '||oi.product_name_snapshot,', ' order by oi.created_at,oi.product_name_snapshot) into v_last_items
    from public.food_order_items oi where oi.organization_id=new.organization_id and oi.order_id=v_last_order_id;
    v_last_order_context:='Último pedido confirmado: '||coalesce(v_last_items,'itens não detalhados')||', total R$ '||replace(to_char(coalesce(v_last_total,0)/100.0,'FM999999990D00'),'.',',')||', realizado em '||to_char(v_last_order_at at time zone 'America/Sao_Paulo','DD/MM/YYYY')||'. ';
  else v_last_order_context:='Não há pedido concluído identificado para este contato no checkout Deskcomm. '; end if;

  if v_pointer_name='Reativação de clientes' then
    v_reason:='Reativação comercial. Faça UMA mensagem curta, humana e muito persuasiva para gerar uma nova compra. Se houver último pedido, use-o naturalmente para demonstrar memória e relevância. Em seguida, procure uma oportunidade real de vender MAIS: consulte o catálogo e ofereça UM produto complementar, upgrade ou nova opção coerente com o histórico. Nunca invente desconto, promoção, produto, preço, estoque ou benefício.';
    v_context:=v_last_order_context||'Não transforme a mensagem em spam. O objetivo é lembrar a preferência do cliente e criar um próximo pedido maior e relevante.';
  else
    v_reason:='Campanha comercial personalizada. Faça UMA mensagem curta, humana e muito persuasiva para gerar nova compra. Se houver último pedido, mencione-o naturalmente. Depois, não se limite a repetir o pedido: consulte o catálogo e ofereça UM complemento, upgrade ou produto adicional realmente compatível para aumentar o ticket. Nunca invente promoção, desconto, preço, estoque ou benefício.';
    v_context:=v_last_order_context||'Use o histórico como memória comercial e o catálogo atual como fonte de verdade. Evite linguagem genérica de disparo em massa.';
  end if;
  insert into public.cron_jobs(organization_id,contact_id,kind,tz,job_kind,payload,next_run_at,enabled,max_attempts)
  values(new.organization_id,new.contact_id,'at','America/Sao_Paulo','followup_turn',jsonb_build_object('mode','agent','reason',v_reason,'context_snapshot',v_context,'food_automation','manual_flow_fallback_v1','food_flow_name',v_pointer_name,'food_enrollment_ref',new.id,'last_order_id',v_last_order_id),now()+interval '20 seconds',true,3);
  return new;
end;
$function$;

revoke all on function public.fn_food_sarah_opening_v2_on_inbound() from public,anon,authenticated;
grant execute on function public.fn_food_sarah_opening_v2_on_inbound() to service_role;
revoke all on function public.fn_food_deterministic_on_inbound() from public,anon,authenticated;
grant execute on function public.fn_food_deterministic_on_inbound() to service_role;
revoke all on function public.fn_food_fast_enqueue_inbound() from public,anon,authenticated;
grant execute on function public.fn_food_fast_enqueue_inbound() to service_role;
revoke all on function public.fn_food_demo_manage_silence_followup() from public,anon,authenticated;
grant execute on function public.fn_food_demo_manage_silence_followup() to service_role;
revoke all on function public.fn_food_demo_schedule_cart_recovery() from public,anon,authenticated;
grant execute on function public.fn_food_demo_schedule_cart_recovery() to service_role;
revoke all on function public.fn_food_demo_schedule_manual_flow_fallback() from public,anon,authenticated;
grant execute on function public.fn_food_demo_schedule_manual_flow_fallback() to service_role;
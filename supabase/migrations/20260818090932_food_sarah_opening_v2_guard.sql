create or replace function public.fn_food_sarah_opening_v2_on_inbound()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org_name text;
  v_slug text;
  v_tz text;
  v_contact_name text;
  v_hour int;
  v_period text;
  v_opening text;
  v_blocked boolean := false;
  v_force_human boolean := false;
  v_anonymized boolean := false;
  v_day date;
begin
  if new.direction <> 'inbound'
     or new.contact_id is null
     or new.conversation_id is null
     or new.channel_session_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.food_commerce_settings f
    where f.organization_id=new.organization_id
      and f.is_enabled=true
  ) then
    return new;
  end if;

  if not exists (
    select 1
    from public.conversations c
    where c.id=new.conversation_id
      and c.organization_id=new.organization_id
      and c.contact_id=new.contact_id
      and c.is_group=false
  ) then
    return new;
  end if;

  if not exists (
    select 1
    from public.channel_sessions s
    where s.id=new.channel_session_id
      and s.organization_id=new.organization_id
      and s.status='WORKING'
      and s.archived_at is null
  ) then
    return new;
  end if;

  select coalesce(c.is_blocked,false),coalesce(c.force_human,false),coalesce(c.is_anonymized,false),
         nullif(btrim(split_part(c.display_name,' ',1)),'')
    into v_blocked,v_force_human,v_anonymized,v_contact_name
  from public.contacts c
  where c.id=new.contact_id and c.organization_id=new.organization_id;

  if v_blocked or v_force_human or v_anonymized then
    return new;
  end if;

  if v_contact_name ~ '^[+0-9(). -]+$' then
    v_contact_name := null;
  end if;

  select coalesce(nullif(f.app_name,''),o.display_name),o.slug,
         coalesce(nullif(o.timezone,''),'America/Sao_Paulo')
    into v_org_name,v_slug,v_tz
  from public.organizations o
  left join public.food_commerce_settings f on f.organization_id=o.id
  where o.id=new.organization_id;

  if v_slug is null then
    return new;
  end if;

  v_day := (coalesce(new.sent_at,new.created_at,now()) at time zone v_tz)::date;

  perform pg_advisory_xact_lock(
    hashtextextended(new.organization_id::text||':'||new.contact_id::text||':'||v_day::text,0)
  );

  if exists (
    select 1
    from public.messages m
    where m.organization_id=new.organization_id
      and m.contact_id=new.contact_id
      and m.direction='outbound'
      and m.sent_via='ai'
      and m.status<>'failed'
      and coalesce((m.metadata->>'sarah_opening_v2')::boolean,false)=true
      and (m.created_at at time zone v_tz)::date=v_day
  ) then
    return new;
  end if;

  v_hour := extract(hour from (coalesce(new.sent_at,new.created_at,now()) at time zone v_tz));
  v_period := case
    when v_hour between 5 and 11 then 'bom dia'
    when v_hour between 12 and 17 then 'boa tarde'
    else 'boa noite'
  end;

  v_opening := 'Olá, '||v_period||coalesce(', '||v_contact_name,'')||'! 😊'
    ||E'\n\n'
    ||'Muito obrigado por ter entrado em contato com a '||v_org_name||'.'
    ||E'\n\n'
    ||'Meu nome é Sarah e vou te atender por aqui. Como posso te ajudar hoje?'
    ||E'\n\n'
    ||'Para acessar nosso cardápio digital, basta acessar o link abaixo:'
    ||E'\n'
    ||'https://gabarronmathias.github.io/DeskcommCRM/'||v_slug||'/';

  insert into public.messages(
    organization_id,conversation_id,channel_session_id,contact_id,
    type,direction,status,body,sent_via,sent_at,metadata,created_at
  )
  select
    new.organization_id,new.conversation_id,new.channel_session_id,new.contact_id,
    'text','outbound','queued',v_opening,'ai',now(),
    jsonb_build_object(
      'ai_actor_id','agent-engine-opening-v2',
      'sarah_opening_v2',true,
      'deterministic_food_early',true,
      'reactive_outbox',true,
      'origin_inbound_message_id',new.id::text
    ),
    now()
  where not exists (
    select 1
    from public.messages existing
    where existing.organization_id=new.organization_id
      and existing.metadata->>'origin_inbound_message_id'=new.id::text
      and coalesce((existing.metadata->>'reactive_outbox')::boolean,false)=true
  );

  return new;
end;
$function$;

revoke all on function public.fn_food_sarah_opening_v2_on_inbound() from public, anon;
grant execute on function public.fn_food_sarah_opening_v2_on_inbound() to service_role;

drop trigger if exists trg_messages_a0_food_opening_v2 on public.messages;
create trigger trg_messages_a0_food_opening_v2
after insert on public.messages
for each row execute function public.fn_food_sarah_opening_v2_on_inbound();

update public.messages m
set metadata=coalesce(m.metadata,'{}'::jsonb)||jsonb_build_object('sarah_opening_v2',true)
where m.direction='outbound'
  and m.sent_via='ai'
  and m.body ilike '%Meu nome é Sarah%'
  and exists (
    select 1 from public.food_commerce_settings f
    where f.organization_id=m.organization_id and f.is_enabled=true
  );

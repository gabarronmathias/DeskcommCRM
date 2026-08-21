-- Regra global de produto:
-- qualquer sessão WhatsApp que entrar em WORKING em uma organização com Sarah
-- publicada ganha roteamento automático para ela. O router é por sessão, então
-- múltiplos WhatsApps podem ser atendidos simultaneamente pela mesma Sarah.

create or replace function public.fn_ensure_sarah_router_for_session(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session record;
  v_sarah_id uuid;
  v_router_id uuid;
begin
  select cs.id,cs.organization_id,cs.status,cs.archived_at
    into v_session
    from public.channel_sessions cs
   where cs.id=p_session_id
   for update;

  if not found or v_session.status is distinct from 'WORKING' or v_session.archived_at is not null then
    return null;
  end if;

  select a.id
    into v_sarah_id
    from public.ai_agents a
    join public.ai_agent_versions v on v.id=a.published_version_id
   where a.organization_id=v_session.organization_id
     and a.archived_at is null
     and lower(trim(a.name))='sarah'
     and v.status='published'
   order by a.priority desc,a.created_at asc
   limit 1;

  -- Sarah sem versão publicada representa pausa/despublicação explícita.
  if v_sarah_id is null then return null; end if;

  select r.id into v_router_id
    from public.ai_routers r
   where r.organization_id=v_session.organization_id
     and r.channel_session_id=p_session_id
     and r.is_active
   order by r.created_at asc
   limit 1
   for update;

  if v_router_id is null then
    insert into public.ai_routers(
      organization_id,name,channel_session_id,is_active,config,fallback_agent_id,created_by
    ) values (
      v_session.organization_id,
      'Sarah • automático',
      p_session_id,
      true,
      jsonb_build_object(
        'classifier_model','claude-haiku-4-5',
        'sticky',true,
        'min_confidence',0.6,
        'managed_by','auto_sarah_working_session_v1'
      ),
      v_sarah_id,
      null
    )
    returning id into v_router_id;
  else
    -- Preserva membros/configuração de routers customizados e garante Sarah
    -- apenas como fallback universal da sessão.
    update public.ai_routers
       set fallback_agent_id=v_sarah_id,updated_at=now()
     where id=v_router_id and fallback_agent_id is distinct from v_sarah_id;
  end if;

  return v_router_id;
end;
$$;

revoke all on function public.fn_ensure_sarah_router_for_session(uuid) from public,anon,authenticated;

create or replace function public.fn_auto_route_sarah_to_working_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status='WORKING' and new.archived_at is null then
    perform public.fn_ensure_sarah_router_for_session(new.id);
  end if;
  return new;
end;
$$;

revoke all on function public.fn_auto_route_sarah_to_working_session() from public,anon,authenticated;

drop trigger if exists trg_channel_sessions_auto_route_sarah on public.channel_sessions;
create trigger trg_channel_sessions_auto_route_sarah
after insert or update of status,archived_at on public.channel_sessions
for each row
execute function public.fn_auto_route_sarah_to_working_session();

-- Também cobre a ordem inversa: WhatsApp já conectado e Sarah publicada depois.
create or replace function public.fn_auto_route_working_sessions_when_sarah_published()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare r record;
begin
  if new.archived_at is not null or lower(trim(new.name)) <> 'sarah' or new.published_version_id is null then
    return new;
  end if;

  if tg_op='UPDATE'
     and old.published_version_id is not distinct from new.published_version_id
     and old.archived_at is not distinct from new.archived_at then
    return new;
  end if;

  for r in
    select cs.id
      from public.channel_sessions cs
     where cs.organization_id=new.organization_id
       and cs.status='WORKING'
       and cs.archived_at is null
  loop
    perform public.fn_ensure_sarah_router_for_session(r.id);
  end loop;

  return new;
end;
$$;

revoke all on function public.fn_auto_route_working_sessions_when_sarah_published() from public,anon,authenticated;

drop trigger if exists trg_ai_agents_auto_route_sarah on public.ai_agents;
create trigger trg_ai_agents_auto_route_sarah
after insert or update of published_version_id,archived_at on public.ai_agents
for each row
execute function public.fn_auto_route_working_sessions_when_sarah_published();

-- Backfill idempotente para sessões que já estavam conectadas quando a migration entrou.
do $$
declare r record;
begin
  for r in select id from public.channel_sessions where status='WORKING' and archived_at is null
  loop
    perform public.fn_ensure_sarah_router_for_session(r.id);
  end loop;
end $$;

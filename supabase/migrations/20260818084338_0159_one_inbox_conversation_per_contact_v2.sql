-- O instalador self-host executa cada statement do baseline em autocommit.
-- `on commit drop` apagava a tabela logo após o CREATE, antes do backfill.
drop table if exists _conversation_merge_map;
create temporary table _conversation_merge_map (
  loser uuid primary key,
  winner uuid not null,
  organization_id uuid not null,
  contact_id uuid not null
);

with ranked as (
  select
    id,organization_id,contact_id,
    row_number() over (
      partition by organization_id,contact_id
      order by coalesce(last_message_at,updated_at,created_at) desc nulls last,created_at desc,id desc
    ) as rn,
    first_value(id) over (
      partition by organization_id,contact_id
      order by coalesce(last_message_at,updated_at,created_at) desc nulls last,created_at desc,id desc
    ) as winner
  from public.conversations
  where is_group=false
)
insert into _conversation_merge_map(loser,winner,organization_id,contact_id)
select id,winner,organization_id,contact_id from ranked where rn>1;

with members as (
  select loser as id,winner from _conversation_merge_map
  union
  select winner as id,winner from _conversation_merge_map
), agg as (
  select m.winner,
         min(c.created_at) as first_created_at,
         max(c.last_inbound_at) as last_inbound_at,
         max(c.last_outbound_at) as last_outbound_at,
         max(c.last_message_at) as last_message_at,
         sum(coalesce(c.unread_count_for_assignee,0))::int as unread_count
  from members m
  join public.conversations c on c.id=m.id
  group by m.winner
)
update public.conversations w
set created_at=a.first_created_at,
    last_inbound_at=a.last_inbound_at,
    last_outbound_at=a.last_outbound_at,
    last_message_at=a.last_message_at,
    unread_count_for_assignee=a.unread_count,
    updated_at=now()
from agg a where w.id=a.winner;

update public.messages t set conversation_id=m.winner from _conversation_merge_map m where t.conversation_id=m.loser;
update public.agent_cases t set conversation_id=m.winner from _conversation_merge_map m where t.conversation_id=m.loser;
update public.ai_agent_runs t set conversation_id=m.winner from _conversation_merge_map m where t.conversation_id=m.loser;
update public.ai_invocations t set conversation_id=m.winner from _conversation_merge_map m where t.conversation_id=m.loser;
update public.ai_router_decisions t set conversation_id=m.winner from _conversation_merge_map m where t.conversation_id=m.loser;
update public.contact_field_proposals t set conversation_id=m.winner from _conversation_merge_map m where t.conversation_id=m.loser;
update public.conversation_assignment_events t set conversation_id=m.winner from _conversation_merge_map m where t.conversation_id=m.loser;
update public.conversation_notes t set conversation_id=m.winner from _conversation_merge_map m where t.conversation_id=m.loser;
update public.followup_enrollments t set conversation_id=m.winner from _conversation_merge_map m where t.conversation_id=m.loser;

insert into public.demanda_conversas (organization_id,demanda_id,conversation_id,vinculada_em)
select d.organization_id,d.demanda_id,m.winner,d.vinculada_em
from public.demanda_conversas d
join _conversation_merge_map m on m.loser=d.conversation_id
on conflict (demanda_id,conversation_id) do nothing;
delete from public.demanda_conversas d using _conversation_merge_map m where d.conversation_id=m.loser;

update public.cron_jobs t
set payload=jsonb_set(t.payload,'{conversation_id}',to_jsonb(m.winner::text),false)
from _conversation_merge_map m where t.payload->>'conversation_id'=m.loser::text;
update public.job_queue t
set payload=jsonb_set(t.payload,'{conversation_id}',to_jsonb(m.winner::text),false)
from _conversation_merge_map m where t.payload->>'conversation_id'=m.loser::text;
update public.event_log t
set payload=jsonb_set(t.payload,'{conversation_id}',to_jsonb(m.winner::text),false)
from _conversation_merge_map m where t.payload->>'conversation_id'=m.loser::text;

delete from public.conversations c using _conversation_merge_map m where c.id=m.loser;

drop table if exists _conversation_merge_map;

create unique index if not exists uniq_conversations_1to1_per_contact
  on public.conversations(organization_id,contact_id)
  where is_group=false;

create or replace function public.fn_upsert_wa_conversation(p_org uuid, p_contact uuid, p_session uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || ':' || p_contact::text,0));

  select c.id into v_id
  from public.conversations c
  where c.organization_id=p_org and c.contact_id=p_contact and c.is_group=false
  order by coalesce(c.last_message_at,c.updated_at,c.created_at) desc nulls last,c.id desc
  limit 1
  for update;

  if v_id is null then
    insert into public.conversations(
      organization_id,contact_id,channel_session_id,channel,status,is_group,
      unread_count_for_assignee,metadata
    ) values (p_org,p_contact,p_session,'whatsapp','open',false,0,'{}'::jsonb)
    returning id into v_id;
  else
    update public.conversations
    set channel_session_id=p_session,
        status=case when status in ('closed','archived') then 'open' else status end,
        status_changed_at=case when status in ('closed','archived') then now() else status_changed_at end,
        updated_at=now()
    where id=v_id;
  end if;

  return v_id;
end;
$function$;

-- Fila tenant-scoped da cadência foodservice: D0 + D+2 e STOP.
create table if not exists public.prospecting_outbound_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.crm_leads(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete restrict,
  kind text not null check (kind in ('opening', 'followup')),
  flow_name text not null default 'Follow-up prospecção 48h',
  message_body text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'cancelled', 'failed')),
  scheduled_for timestamptz not null default now(),
  claimed_at timestamptz,
  attempts smallint not null default 0 check (attempts between 0 and 10),
  max_attempts smallint not null default 5 check (max_attempts between 1 and 10),
  idempotency_key text not null,
  crm_message_id uuid references public.messages(id) on delete set null,
  sent_at timestamptz,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

create index if not exists prospecting_outbound_due_idx
  on public.prospecting_outbound_queue (organization_id, scheduled_for, created_at)
  where status = 'pending';
create index if not exists prospecting_outbound_contact_idx
  on public.prospecting_outbound_queue (organization_id, contact_id, created_at desc);

alter table public.prospecting_outbound_queue enable row level security;
drop policy if exists prospecting_outbound_select on public.prospecting_outbound_queue;
create policy prospecting_outbound_select on public.prospecting_outbound_queue
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );
drop policy if exists prospecting_outbound_manager_write on public.prospecting_outbound_queue;
create policy prospecting_outbound_manager_write on public.prospecting_outbound_queue
  for all using (public.fn_role_at_least(organization_id, 'manager') or public.fn_is_platform_admin())
  with check (public.fn_role_at_least(organization_id, 'manager') or public.fn_is_platform_admin());

revoke all on public.prospecting_outbound_queue from anon;

-- Claim pequeno e atômico. Um tick envia no máximo o limite recebido; produção usa 1.
create or replace function public.fn_claim_prospecting_outbound(p_org uuid, p_limit integer default 1)
returns setof public.prospecting_outbound_queue
language sql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $$
  with candidates as (
    select q.id
      from public.prospecting_outbound_queue q
     where q.organization_id = p_org
       and q.status = 'pending'
       and q.scheduled_for <= now()
     order by q.scheduled_for, q.created_at
     limit greatest(1, least(coalesce(p_limit, 1), 20))
     for update skip locked
  )
  update public.prospecting_outbound_queue q
     set status = 'processing', claimed_at = now(), attempts = q.attempts + 1, updated_at = now()
   where q.id in (select id from candidates)
  returning q.*;
$$;

revoke execute on function public.fn_claim_prospecting_outbound(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.fn_claim_prospecting_outbound(uuid, integer)
  to service_role;

-- Qualquer inbound mata o D+2 antes que outro tick consiga reclamá-lo.
create or replace function public.fn_cancel_prospecting_followup_on_inbound()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.direction = 'inbound' then
    update public.prospecting_outbound_queue
       set status = 'cancelled', error_code = 'replied', error_message = null, updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.contact_id
       and kind = 'followup'
       and status in ('pending', 'processing');

    update public.crm_leads
       set custom_fields = jsonb_set(
             jsonb_set(coalesce(custom_fields, '{}'::jsonb), '{last_reply_at}', to_jsonb(coalesce(new.sent_at, now())), true),
             '{next_followup_at}', 'null'::jsonb, true
           ),
           last_activity_at = coalesce(new.sent_at, now()),
           updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.contact_id
       and source = 'google_places';

    insert into public.crm_lead_activities
      (organization_id, lead_id, contact_id, source_module, source_id, type, payload, metadata, performed_at)
    select l.organization_id, l.id, l.contact_id, 'prospecting', new.id,
           'prospecting_reply_received',
           jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id),
           jsonb_build_object('source', 'google_places', 'outcome', 'followup_cancelled'),
           coalesce(new.sent_at, now())
      from public.crm_leads l
     where l.organization_id = new.organization_id
       and l.contact_id = new.contact_id
       and l.source = 'google_places';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cancel_prospecting_followup_on_inbound on public.messages;
create trigger trg_cancel_prospecting_followup_on_inbound
after insert on public.messages
for each row execute function public.fn_cancel_prospecting_followup_on_inbound();

-- STOP é fonte única em contacts.is_blocked: cancela fila, follow-up e marca CRM.
create or replace function public.fn_apply_prospecting_opt_out()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.is_blocked and not old.is_blocked and exists (
    select 1 from public.crm_leads l
     where l.organization_id = new.organization_id
       and l.contact_id = new.id
       and l.source = 'google_places'
  ) then
    update public.contacts
       set tags = array(select distinct x from unnest(coalesce(tags, '{}'::text[]) || array['nao-contatar']) x),
           updated_at = now()
     where id = new.id and organization_id = new.organization_id;

    update public.crm_leads
       set tags = array(select distinct x from unnest(coalesce(tags, '{}'::text[]) || array['nao-contatar']) x),
           custom_fields = jsonb_set(
             jsonb_set(coalesce(custom_fields, '{}'::jsonb), '{opt_out}', 'true'::jsonb, true),
             '{next_followup_at}', 'null'::jsonb, true
           ),
           updated_at = now()
     where organization_id = new.organization_id and contact_id = new.id;

    update public.prospecting_outbound_queue
       set status = 'cancelled', error_code = 'opt_out', error_message = null, updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.id
       and status in ('pending', 'processing');

    update public.followup_enrollments
       set status = 'cancelled', outcome = 'opted_out', cancel_reason = 'contact_is_blocked',
           next_eval_at = null, claimed_until = null, completed_at = now(), updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.id
       and status in ('active', 'waiting_reply', 'paused_handoff', 'paused_manual');

    insert into public.crm_lead_activities
      (organization_id, lead_id, contact_id, source_module, type, payload, metadata)
    select l.organization_id, l.id, l.contact_id, 'prospecting', 'prospecting_opt_out',
           jsonb_build_object('reason', 'explicit_do_not_contact'),
           jsonb_build_object('source', 'prospecting', 'outcome', 'automations_cancelled')
      from public.crm_leads l
     where l.organization_id = new.organization_id
       and l.contact_id = new.id
       and l.source = 'google_places';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_apply_prospecting_opt_out on public.contacts;
create trigger trg_apply_prospecting_opt_out
after update of is_blocked on public.contacts
for each row execute function public.fn_apply_prospecting_opt_out();

revoke execute on function public.fn_cancel_prospecting_followup_on_inbound()
  from public, anon, authenticated;
revoke execute on function public.fn_apply_prospecting_opt_out()
  from public, anon, authenticated;
grant execute on function public.fn_cancel_prospecting_followup_on_inbound(), public.fn_apply_prospecting_opt_out()
  to service_role;

-- Dedup forte para a fonte oficial. Null continua permitido para leads de outras fontes.
create unique index if not exists crm_leads_google_place_org_uniq
  on public.crm_leads (organization_id, ((source_metadata ->> 'google_place_id')))
  where source = 'google_places' and nullif(source_metadata ->> 'google_place_id', '') is not null;

notify pgrst, 'reload schema';

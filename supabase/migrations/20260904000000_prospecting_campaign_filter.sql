-- Filtro de campanha na fila de prospecção outbound.
--
-- Contexto: a fila herdada do foodservice foi preenchida com leads de
-- openstreetmap antes de existir a campanha curada `gb-foodservice-sjc-2026-09`
-- (enviada para Casa Faísca no smoke test). Sem um discriminador de campanha,
-- o claim da RPC pega o mais antigo entre todos os `status='pending'`,
-- incluindo os 12 OSM legados.
--
-- Solução: o claim aceita um `p_campaign` opcional. Quando fornecido, só
-- considera rows onde `metadata->>'campaign' = p_campaign`. Quando nulo,
-- mantém o comportamento legado (claim cego). Os 12 OSM são marcados com
-- `metadata.campaign = 'gb-osm-archive-2026-08'` por uma migration/rota
-- separada — preservados para auditoria, inelegíveis para a campanha atual.
--
-- A função de opt-out e a de cancel de followup por inbound passam a cobrir
-- `manual_curated` além de `google_places` (paridade de tratamento entre as
-- duas fontes curadas de prospecção outbound).

create or replace function public.fn_claim_prospecting_outbound(
  p_org uuid,
  p_limit integer default 1,
  p_campaign text default null
)
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
       and (p_campaign is null or q.metadata->>'campaign' = p_campaign)
     order by q.scheduled_for, q.created_at
     limit greatest(1, least(coalesce(p_limit, 1), 20))
     for update skip locked
  )
  update public.prospecting_outbound_queue q
     set status = 'processing', claimed_at = now(),
         attempts = q.attempts + 1, updated_at = now()
   where q.id in (select id from candidates)
  returning q.*;
$$;

revoke execute on function public.fn_claim_prospecting_outbound(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.fn_claim_prospecting_outbound(uuid, integer, text)
  to service_role;

-- Paridade manual_curated na função de cancel de followup por inbound.
create or replace function public.fn_cancel_prospecting_followup_on_inbound()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.direction = 'inbound' then
    update public.prospecting_outbound_queue
       set status = 'cancelled', error_code = 'replied',
           error_message = null, updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.contact_id
       and kind = 'followup'
       and status in ('pending', 'processing');

    update public.crm_leads
       set custom_fields = jsonb_set(
             jsonb_set(coalesce(custom_fields, '{}'::jsonb),
                       '{last_reply_at}',
                       to_jsonb(coalesce(new.sent_at, now())), true),
             '{next_followup_at}', 'null'::jsonb, true
           ),
           last_activity_at = coalesce(new.sent_at, now()),
           updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.contact_id
       and source in ('google_places', 'manual_curated');

    insert into public.crm_lead_activities
      (organization_id, lead_id, contact_id, source_module, source_id, type, payload, metadata, performed_at)
    select l.organization_id, l.id, l.contact_id, 'prospecting', new.id,
           'prospecting_reply_received',
           jsonb_build_object('conversation_id', new.conversation_id, 'message_id', new.id),
           jsonb_build_object('source', l.source, 'outcome', 'followup_cancelled'),
           coalesce(new.sent_at, now())
      from public.crm_leads l
     where l.organization_id = new.organization_id
       and l.contact_id = new.contact_id
       and l.source in ('google_places', 'manual_curated');
  end if;
  return new;
end;
$$;

-- Paridade manual_curated no opt-out.
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
       and l.source in ('google_places', 'manual_curated')
  ) then
    update public.contacts
       set tags = array(select distinct x from unnest(coalesce(tags, '{}'::text[]) || array['nao-contatar']) x),
           updated_at = now()
     where id = new.id and organization_id = new.organization_id;

    update public.crm_leads
       set tags = array(select distinct x from unnest(coalesce(tags, '{}'::text[]) || array['nao-contatar']) x),
           custom_fields = jsonb_set(
             jsonb_set(coalesce(custom_fields, '{}'::jsonb),
                       '{opt_out}', 'true'::jsonb, true),
             '{next_followup_at}', 'null'::jsonb, true
           ),
           updated_at = now()
     where organization_id = new.organization_id and contact_id = new.id;

    update public.prospecting_outbound_queue
       set status = 'cancelled', error_code = 'opt_out',
           error_message = null, updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.id
       and status in ('pending', 'processing');

    update public.followup_enrollments
       set status = 'cancelled', outcome = 'opted_out',
           cancel_reason = 'contact_is_blocked',
           next_eval_at = null, claimed_until = null,
           completed_at = now(), updated_at = now()
     where organization_id = new.organization_id
       and contact_id = new.id
       and status in ('active', 'waiting_reply', 'paused_handoff', 'paused_manual');

    insert into public.crm_lead_activities
      (organization_id, lead_id, contact_id, source_module, type, payload, metadata)
    select l.organization_id, l.id, l.contact_id, 'prospecting', 'prospecting_opt_out',
           jsonb_build_object('reason', 'explicit_do_not_contact'),
           jsonb_build_object('source', l.source, 'outcome', 'automations_cancelled')
      from public.crm_leads l
     where l.organization_id = new.organization_id
       and l.contact_id = new.id
       and l.source in ('google_places', 'manual_curated');
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';

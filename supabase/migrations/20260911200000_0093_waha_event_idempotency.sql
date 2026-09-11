-- WAHA retry safety: the message row may already exist when the webhook is
-- retried after a worker/event-log failure. A stable source_event_key lets the
-- event bus return the original event instead of enqueueing another turn.

create unique index if not exists event_log_source_event_key_uq
  on public.event_log (organization_id, event_type, (metadata ->> 'source_event_key'))
  where metadata ? 'source_event_key';

create or replace function public.emit_event(
  p_event_type text,
  p_entity_kind text,
  p_entity_id uuid,
  p_payload jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb,
  p_organization_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_event_id uuid;
  v_metadata jsonb;
begin
  v_org_id := p_organization_id;
  if v_org_id is null then
    select organization_id into v_org_id
      from public.user_organizations
      where user_id = auth.uid() and revoked_at is null
      limit 1;
  end if;
  if v_org_id is null then
    raise exception 'emit_event: organization_id obrigatorio';
  end if;

  v_metadata := coalesce(p_metadata, '{}'::jsonb)
    || jsonb_build_object('emitted_at', extract(epoch from now()));

  if v_metadata ? 'source_event_key' then
    select id into v_event_id
    from public.event_log
    where organization_id = v_org_id
      and event_type = p_event_type
      and metadata ->> 'source_event_key' = v_metadata ->> 'source_event_key'
    limit 1;
    if v_event_id is not null then return v_event_id; end if;
  end if;

  begin
    insert into public.event_log
      (organization_id, event_type, entity_kind, entity_id, payload, metadata)
    values
      (v_org_id, p_event_type, p_entity_kind, p_entity_id,
       coalesce(p_payload, '{}'::jsonb), v_metadata)
    returning id into v_event_id;
  exception when unique_violation then
    if v_metadata ? 'source_event_key' then
      select id into v_event_id
      from public.event_log
      where organization_id = v_org_id
        and event_type = p_event_type
        and metadata ->> 'source_event_key' = v_metadata ->> 'source_event_key'
      limit 1;
      if v_event_id is not null then return v_event_id; end if;
    end if;
    raise;
  end;
  return v_event_id;
end;
$$;

revoke execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid)
  from public, anon;
grant execute on function public.emit_event(text, text, uuid, jsonb, jsonb, uuid)
  to authenticated, service_role;


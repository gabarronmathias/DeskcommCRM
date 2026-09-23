-- Fresh-install correction: contacts/conversations expose globally unique IDs,
-- but no composite (id, organization_id) unique keys in every baseline.
-- Tenant ownership is checked by the launch/event handlers and the order RPC.
alter table public.partner_launches
  drop constraint if exists partner_launches_contact_org_fk,
  drop constraint if exists partner_launches_conversation_org_fk;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.partner_launches'::regclass
      and conname = 'partner_launches_contact_fk'
  ) then
    alter table public.partner_launches
      add constraint partner_launches_contact_fk
      foreign key (contact_id) references public.contacts(id) on delete cascade;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.partner_launches'::regclass
      and conname = 'partner_launches_conversation_fk'
  ) then
    alter table public.partner_launches
      add constraint partner_launches_conversation_fk
      foreign key (conversation_id) references public.conversations(id) on delete restrict;
  end if;
end;
$$;

create or replace function public.fn_food_pause_ai_on_human_device_reply()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.direction<>'outbound'
     or new.sent_via<>'external_device'
     or new.contact_id is null
     or new.conversation_id is null then
    return new;
  end if;

  if not exists(
    select 1 from public.food_commerce_settings f
    where f.organization_id=new.organization_id and f.is_enabled=true
  ) then
    return new;
  end if;

  -- Um atendente humano assumiu a conversa pelo aparelho. Sarah nao entra no meio
  -- durante 30 minutos; cada nova resposta humana renova a janela.
  update public.conversations c
     set bot_silenced_until=greatest(coalesce(c.bot_silenced_until,now()),now()+interval '30 minutes'),
         updated_at=now()
   where c.id=new.conversation_id
     and c.organization_id=new.organization_id
     and c.contact_id=new.contact_id
     and c.is_group=false;

  -- Retomadas automaticas pendentes deixam de fazer sentido enquanto o humano atende.
  update public.cron_jobs
     set enabled=false,
         cancelled_at=coalesce(cancelled_at,now()),
         cancel_reason=coalesce(cancel_reason,'atendimento assumido manualmente no WhatsApp'),
         updated_at=now()
   where organization_id=new.organization_id
     and contact_id=new.contact_id
     and enabled=true
     and payload->>'food_automation' in ('cart_recovery_v1','silence_followup_v1');

  return new;
end;
$function$;

revoke all on function public.fn_food_pause_ai_on_human_device_reply() from public,anon,authenticated;
grant execute on function public.fn_food_pause_ai_on_human_device_reply() to service_role;

drop trigger if exists trg_messages_human_device_pauses_food_ai on public.messages;
create trigger trg_messages_human_device_pauses_food_ai
after insert on public.messages
for each row execute function public.fn_food_pause_ai_on_human_device_reply();
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

  update public.job_queue
     set status='done',
         last_error='cancelado: atendimento assumido manualmente no WhatsApp',
         locked_by=null,
         locked_at=null
   where organization_id=new.organization_id
     and contact_id=new.contact_id
     and status='pending'
     and kind in ('inbound_turn','followup_turn');

  update public.event_log
     set status='done',
         last_error=coalesce(last_error,'cancelado: atendimento assumido manualmente no WhatsApp'),
         updated_at=now()
   where organization_id=new.organization_id
     and event_type='ai_agent.dispatch_requested'
     and status='pending'
     and payload->>'contact_id'=new.contact_id::text;

  return new;
end;
$function$;

revoke all on function public.fn_food_pause_ai_on_human_device_reply() from public,anon,authenticated;
grant execute on function public.fn_food_pause_ai_on_human_device_reply() to service_role;
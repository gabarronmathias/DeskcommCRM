create or replace function public.fn_enable_food_demo_commercial_flows_on_working_session()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org_slug text;
  v_agent record;
  v_pointer_ids text[];
  v_pointer_count integer;
  v_next_version integer;
  v_new_version_id uuid;
  v_prompt text;
  v_marker constant text := '[FOODSERVICE_COMERCIAL_DEMO_V1]';
  v_block constant text := $block$

[FOODSERVICE_COMERCIAL_DEMO_V1]
MOTOR COMERCIAL FOODSERVICE

TICKET MÉDIO
Quando o cliente já escolheu um ou mais itens e o pedido ainda não foi concluído, faça UMA tentativa curta de venda complementar antes de finalizar, desde que ele não tenha recusado adicionais nem pedido objetividade. Consulte crm_search_products antes da sugestão e ofereça no máximo UM complemento realmente compatível com o que ele está comprando. Pode ser bebida, sobremesa, acompanhamento ou outro item pertinente do catálogo. Nunca invente produto, preço, estoque, desconto, combo ou promoção. A sugestão não pode impedir nem atrasar a conclusão do pedido.

CONTINUIDADE / FOLLOW-UP
Se o cliente demonstrar intenção comercial e combinar que será chamado depois, pedir para ser lembrado, disser que quer retomar em outro horário ou aceitar explicitamente um retorno, não deixe essa promessa apenas no texto. Se ainda não houver horário, pergunte qual horário prefere. Assim que houver um horário explícito, use schedule_followup com o contexto essencial e encerre o turno após o agendamento. Não empilhe retornos, não agende depois de recusa/opt-out e não invente consentimento ou horário.

RECUPERAÇÃO, REATIVAÇÃO E CAMPANHAS
Quando o turno tiver sido disparado por um fluxo comercial, siga o objetivo e o contexto injetados pelo fluxo. Preserve o histórico, use somente dados reais disponíveis nas ferramentas e mantenha a mensagem curta e natural. Nunca exponha nomes internos de fluxo, tags, estágios ou termos de sistema ao cliente.
$block$;
begin
  select o.slug into v_org_slug
  from public.organizations o
  where o.id=new.organization_id;

  if v_org_slug not in ('capri','chopperia-do-gordo')
     or new.status is distinct from 'WORKING'
     or new.archived_at is not null then
    return new;
  end if;

  select a.id as agent_id,
         a.published_version_id,
         v.*
    into v_agent
    from public.ai_agents a
    join public.ai_agent_versions v on v.id=a.published_version_id
   where a.organization_id=new.organization_id
     and a.name='Sarah'
     and a.archived_at is null
     and v.status='published'
     and v.channel_session_id=new.id
   limit 1;

  if not found then return new; end if;

  select array_agg(p.id::text order by p.name),count(*)::int
    into v_pointer_ids,v_pointer_count
    from public.followup_flow_pointers p
   where p.organization_id=new.organization_id
     and p.status='active'
     and p.active_version_id is not null
     and p.name in ('Recuperação de carrinho','Follow-up automático','Reativação de clientes','Campanhas na base');

  if v_pointer_count<>4 then return new; end if;

  -- Normaliza ANTES de decidir se há trabalho. Assim qualquer regra nova de prompt
  -- também força publicação, mesmo quando os quatro fluxos já estavam corretos.
  v_prompt:=public.fn_food_normalize_sarah_prompt(v_agent.system_prompt);
  if position(v_marker in v_prompt)=0 then
    v_prompt:=rtrim(v_prompt)||v_block;
  end if;

  if coalesce((v_agent.followup->>'enabled')::boolean,false)
     and (v_agent.followup->'flow_pointer_ids') @> to_jsonb(v_pointer_ids)
     and v_prompt is not distinct from v_agent.system_prompt then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_agent.agent_id::text));

  select coalesce(max(version_number),0)+1
    into v_next_version
    from public.ai_agent_versions
   where agent_id=v_agent.agent_id;

  insert into public.ai_agent_versions(
    organization_id,agent_id,version_number,system_prompt,provider,model,credential_id,
    tool_ids,trigger_config,channel_session_id,max_steps,token_budget,cost_budget_cents,
    history_message_window,history_token_window,handoff_keywords,handoff_tool_enabled,
    status,created_by,followup,multimodal_input,video_frames_enabled,
    split_messages,split_max_chars,cases_enabled,operator_enabled,operator_model,
    operator_tool_ids,pipeline_ids
  ) values (
    v_agent.organization_id,v_agent.agent_id,v_next_version,v_prompt,
    v_agent.provider,v_agent.model,v_agent.credential_id,
    v_agent.tool_ids,v_agent.trigger_config,new.id,v_agent.max_steps,
    v_agent.token_budget,v_agent.cost_budget_cents,
    v_agent.history_message_window,v_agent.history_token_window,
    v_agent.handoff_keywords,v_agent.handoff_tool_enabled,
    'draft',v_agent.created_by,
    jsonb_build_object('enabled',true,'flow_pointer_ids',to_jsonb(v_pointer_ids)),
    v_agent.multimodal_input,v_agent.video_frames_enabled,
    v_agent.split_messages,v_agent.split_max_chars,v_agent.cases_enabled,
    v_agent.operator_enabled,v_agent.operator_model,v_agent.operator_tool_ids,
    v_agent.pipeline_ids
  ) returning id into v_new_version_id;

  perform public.fn_publish_ai_agent_version(new.organization_id,v_agent.agent_id,v_new_version_id);
  update public.ai_agents
     set system_prompt=public.fn_food_normalize_sarah_prompt(system_prompt),updated_at=now()
   where id=v_agent.agent_id;

  return new;
end;
$function$;

revoke all on function public.fn_enable_food_demo_commercial_flows_on_working_session() from public,anon,authenticated;
grant execute on function public.fn_enable_food_demo_commercial_flows_on_working_session() to service_role;
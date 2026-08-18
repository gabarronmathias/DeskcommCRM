do $do$
declare
  r record;
  v_next integer;
  v_new uuid;
  v_current text;
  v_normalized text;
begin
  for r in
    select a.id as agent_id,a.organization_id,a.published_version_id
    from public.ai_agents a
    join public.organizations o on o.id=a.organization_id
    join public.ai_agent_versions v on v.id=a.published_version_id
    join public.channel_sessions cs on cs.id=v.channel_session_id and cs.organization_id=a.organization_id
    where o.slug in ('capri','chopperia-do-gordo')
      and a.name='Sarah'
      and a.archived_at is null
      and cs.status='WORKING'
      and cs.archived_at is null
  loop
    select v.system_prompt,public.fn_food_normalize_sarah_prompt(v.system_prompt)
      into v_current,v_normalized
    from public.ai_agent_versions v
    where v.id=r.published_version_id;

    if v_normalized is distinct from v_current then
      select coalesce(max(version_number),0)+1
        into v_next
      from public.ai_agent_versions
      where agent_id=r.agent_id;

      insert into public.ai_agent_versions(
        organization_id,agent_id,version_number,system_prompt,provider,model,credential_id,
        tool_ids,trigger_config,channel_session_id,max_steps,token_budget,cost_budget_cents,
        history_message_window,history_token_window,handoff_keywords,handoff_tool_enabled,
        status,created_by,followup,multimodal_input,video_frames_enabled,
        split_messages,split_max_chars,cases_enabled,operator_enabled,operator_model,
        operator_tool_ids,pipeline_ids
      )
      select organization_id,agent_id,v_next,v_normalized,provider,model,credential_id,
        tool_ids,trigger_config,channel_session_id,max_steps,token_budget,cost_budget_cents,
        history_message_window,history_token_window,handoff_keywords,handoff_tool_enabled,
        'draft',created_by,followup,multimodal_input,video_frames_enabled,
        split_messages,split_max_chars,cases_enabled,operator_enabled,operator_model,
        operator_tool_ids,pipeline_ids
      from public.ai_agent_versions
      where id=r.published_version_id
      returning id into v_new;

      perform public.fn_publish_ai_agent_version(r.organization_id,r.agent_id,v_new);
    end if;
  end loop;
end;
$do$;
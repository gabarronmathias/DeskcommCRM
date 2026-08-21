create or replace function public.fn_food_normalize_sarah_prompt(p_prompt text)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_prompt text := coalesce(p_prompt,'');
  v_neutral_pos integer;
  v_named_marker constant text := '[SAUDACAO_NOME_GARANTIDA_V2]';
  v_named_block constant text := $block$

[SAUDACAO_NOME_GARANTIDA_V2]
REGRA FINAL E SOBERANA DE SAUDAÇÃO — PRIORIDADE MÁXIMA
- Esta regra substitui qualquer instrução anterior que mande usar somente saudação neutra, proíba bom dia/boa tarde/boa noite ou mande ignorar o nome conhecido do contato.
- O fuso oficial é America/Sao_Paulo. 05:00–11:59 = bom dia; 12:00–17:59 = boa tarde; 18:00–04:59 = boa noite.
- Se o CRM/contexto já fornecer o nome do contato e ele não for um telefone, use o PRIMEIRO NOME já na primeira linha da saudação. Exemplo: "Olá, bom dia, Sandra! 😊".
- É proibido responder apenas "Olá! Como posso te ajudar?" quando o nome do contato já estiver disponível.
- Na PRIMEIRA resposta da Sarah do dia para aquele contato, a abertura deve também apresentar a atendente: "Muito obrigado por ter entrado em contato com a empresa. Meu nome é Sarah e vou te atender por aqui. Como posso te ajudar hoje?". Quando houver link oficial do cardápio, inclua-o nessa abertura conforme a configuração do estabelecimento.
- Nas mensagens seguintes do mesmo dia, não repita a apresentação; use o nome naturalmente quando fizer sentido.
- Se o nome não estiver disponível, use a saudação pelo período sem inventar nome.
- Se uma camada determinística já tiver produzido a abertura do turno, não envie uma segunda saudação duplicada.
$block$;
begin
  v_neutral_pos := position('[SAUDACAO_NEUTRA_DEMO_V1]' in v_prompt);
  if v_neutral_pos > 0 then
    v_prompt := rtrim(substring(v_prompt from 1 for v_neutral_pos - 1));
  end if;

  v_prompt := replace(
    v_prompt,
    'Não use automaticamente o nome do contato na saudação.',
    'Quando o nome do contato estiver disponível no contexto, use o primeiro nome na saudação inicial; nunca invente um nome.'
  );
  v_prompt := replace(
    v_prompt,
    'Não use bom dia, boa tarde ou boa noite. Use sempre uma saudação neutra.',
    'Use bom dia, boa tarde ou boa noite conforme o horário local em America/Sao_Paulo.'
  );

  if position(v_named_marker in v_prompt) = 0 then
    v_prompt := rtrim(v_prompt) || v_named_block;
  end if;

  return v_prompt;
end;
$function$;

revoke all on function public.fn_food_normalize_sarah_prompt(text) from public, anon;
grant execute on function public.fn_food_normalize_sarah_prompt(text) to service_role;

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
  v_named_marker constant text := '[SAUDACAO_NOME_GARANTIDA_V2]';
  v_neutral_marker constant text := '[SAUDACAO_NEUTRA_DEMO_V1]';
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
    join public.ai_agent_versions v on v.id = a.published_version_id
   where a.organization_id = new.organization_id
     and a.name = 'Sarah'
     and a.archived_at is null
     and v.status = 'published'
     and v.channel_session_id = new.id
   limit 1;

  if not found then
    return new;
  end if;

  select array_agg(p.id::text order by p.name), count(*)::int
    into v_pointer_ids, v_pointer_count
    from public.followup_flow_pointers p
   where p.organization_id = new.organization_id
     and p.status = 'active'
     and p.active_version_id is not null
     and p.name in (
       'Recuperação de carrinho',
       'Follow-up automático',
       'Reativação de clientes',
       'Campanhas na base'
     );

  if v_pointer_count <> 4 then
    return new;
  end if;

  if coalesce((v_agent.followup ->> 'enabled')::boolean, false)
     and (v_agent.followup -> 'flow_pointer_ids') @> to_jsonb(v_pointer_ids)
     and position(v_marker in v_agent.system_prompt) > 0
     and position(v_named_marker in v_agent.system_prompt) > 0
     and position(v_neutral_marker in v_agent.system_prompt) = 0 then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_agent.agent_id::text));

  select coalesce(max(version_number), 0) + 1
    into v_next_version
    from public.ai_agent_versions
   where agent_id = v_agent.agent_id;

  v_prompt := public.fn_food_normalize_sarah_prompt(v_agent.system_prompt);
  if position(v_marker in v_prompt) = 0 then
    v_prompt := rtrim(v_prompt) || v_block;
  end if;

  insert into public.ai_agent_versions (
    organization_id, agent_id, version_number, system_prompt, provider, model, credential_id,
    tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents,
    history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled,
    status, created_by, followup, multimodal_input, video_frames_enabled,
    split_messages, split_max_chars, cases_enabled, operator_enabled, operator_model,
    operator_tool_ids, pipeline_ids
  ) values (
    v_agent.organization_id, v_agent.agent_id, v_next_version, v_prompt,
    v_agent.provider, v_agent.model, v_agent.credential_id,
    v_agent.tool_ids, v_agent.trigger_config, new.id, v_agent.max_steps,
    v_agent.token_budget, v_agent.cost_budget_cents,
    v_agent.history_message_window, v_agent.history_token_window,
    v_agent.handoff_keywords, v_agent.handoff_tool_enabled,
    'draft', v_agent.created_by,
    jsonb_build_object('enabled', true, 'flow_pointer_ids', to_jsonb(v_pointer_ids)),
    v_agent.multimodal_input, v_agent.video_frames_enabled,
    v_agent.split_messages, v_agent.split_max_chars, v_agent.cases_enabled,
    v_agent.operator_enabled, v_agent.operator_model, v_agent.operator_tool_ids,
    v_agent.pipeline_ids
  ) returning id into v_new_version_id;

  perform public.fn_publish_ai_agent_version(new.organization_id, v_agent.agent_id, v_new_version_id);
  update public.ai_agents
     set system_prompt=public.fn_food_normalize_sarah_prompt(system_prompt), updated_at=now()
   where id=v_agent.agent_id;

  return new;
end;
$function$;

revoke all on function public.fn_enable_food_demo_commercial_flows_on_working_session() from public, anon;
grant execute on function public.fn_enable_food_demo_commercial_flows_on_working_session() to service_role;

update public.ai_agents a
set system_prompt=public.fn_food_normalize_sarah_prompt(a.system_prompt), updated_at=now()
from public.organizations o
where o.id=a.organization_id
  and o.slug in ('capri','chopperia-do-gordo')
  and a.name='Sarah'
  and a.archived_at is null;

do $do$
declare
  v_agent record;
  v_next_version integer;
  v_new_version_id uuid;
  v_prompt text;
begin
  select a.id as agent_id,a.organization_id,v.*
    into v_agent
  from public.ai_agents a
  join public.organizations o on o.id=a.organization_id
  join public.ai_agent_versions v on v.id=a.published_version_id
  join public.channel_sessions s on s.id=v.channel_session_id
  where o.slug='capri'
    and a.name='Sarah'
    and a.archived_at is null
    and v.status='published'
    and s.status='WORKING'
    and s.archived_at is null
  limit 1;

  if not found then
    -- Instalações novas não têm a organização de demonstração. A asserção só
    -- deve bloquear quando a Capri existe e está com a publicação inconsistente.
    if not exists (select 1 from public.organizations where slug='capri') then
      return;
    end if;
    raise exception 'capri_published_sarah_working_session_not_found';
  end if;

  v_prompt := public.fn_food_normalize_sarah_prompt(v_agent.system_prompt);
  if v_prompt = v_agent.system_prompt then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_agent.agent_id::text));
  select coalesce(max(version_number),0)+1 into v_next_version
  from public.ai_agent_versions where agent_id=v_agent.agent_id;

  insert into public.ai_agent_versions (
    organization_id,agent_id,version_number,system_prompt,provider,model,credential_id,
    tool_ids,trigger_config,channel_session_id,max_steps,token_budget,cost_budget_cents,
    history_message_window,history_token_window,handoff_keywords,handoff_tool_enabled,
    status,created_by,followup,multimodal_input,video_frames_enabled,
    split_messages,split_max_chars,cases_enabled,operator_enabled,operator_model,
    operator_tool_ids,pipeline_ids
  ) values (
    v_agent.organization_id,v_agent.agent_id,v_next_version,v_prompt,
    v_agent.provider,v_agent.model,v_agent.credential_id,
    v_agent.tool_ids,v_agent.trigger_config,v_agent.channel_session_id,v_agent.max_steps,
    v_agent.token_budget,v_agent.cost_budget_cents,
    v_agent.history_message_window,v_agent.history_token_window,
    v_agent.handoff_keywords,v_agent.handoff_tool_enabled,
    'draft',v_agent.created_by,v_agent.followup,v_agent.multimodal_input,v_agent.video_frames_enabled,
    v_agent.split_messages,v_agent.split_max_chars,v_agent.cases_enabled,
    v_agent.operator_enabled,v_agent.operator_model,v_agent.operator_tool_ids,v_agent.pipeline_ids
  ) returning id into v_new_version_id;

  perform public.fn_publish_ai_agent_version(v_agent.organization_id,v_agent.agent_id,v_new_version_id);
end;
$do$;

create or replace function public.fn_food_normalize_sarah_prompt(p_prompt text)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_prompt text:=coalesce(p_prompt,'');
  v_neutral_pos integer;
  v_named_marker constant text:='[SAUDACAO_NOME_GARANTIDA_V2]';
  v_sales_marker constant text:='[FOODSERVICE_VENDAS_PERSUASIVAS_V2]';
  v_coherence_marker constant text:='[FOODSERVICE_CONTINUIDADE_V1]';
  v_once_marker constant text:='[SAUDACAO_SOMENTE_PRIMEIRA_MENSAGEM_V3]';
  v_named_block constant text:=$named$

[SAUDACAO_NOME_GARANTIDA_V2]
REGRA FINAL E SOBERANA DE SAUDAÇÃO — PRIORIDADE MÁXIMA
- Esta regra substitui qualquer instrução anterior que mande usar somente saudação neutra, proíba bom dia/boa tarde/boa noite ou mande ignorar o nome conhecido do contato.
- O fuso oficial é America/Sao_Paulo. 05:00–11:59 = bom dia; 12:00–17:59 = boa tarde; 18:00–04:59 = boa noite.
- Se o CRM/contexto já fornecer o nome do contato e ele não for um telefone, use o PRIMEIRO NOME já na primeira linha da PRIMEIRA resposta do atendimento. Exemplo: "Olá, bom dia, Sandra! 😊".
- É proibido responder apenas "Olá! Como posso te ajudar?" quando o nome do contato já estiver disponível na primeira resposta.
- Na PRIMEIRA resposta da Sarah nesta conversa para aquele contato, a abertura deve também apresentar a atendente: "Muito obrigado por ter entrado em contato com a empresa. Meu nome é Sarah e vou te atender por aqui. Como posso te ajudar hoje?". Quando houver link oficial do cardápio, inclua-o nessa abertura conforme a configuração do estabelecimento.
- Depois dessa primeira resposta, NÃO repita bom dia/boa tarde/boa noite nem a apresentação da Sarah nesta conversa, mesmo em outro dia. Continue diretamente do ponto atual.
- Se o nome não estiver disponível, use a saudação pelo período sem inventar nome.
- Se uma camada determinística já tiver produzido a abertura do turno, não envie uma segunda saudação duplicada.
$named$;
  v_sales_block constant text:=$sales$

[FOODSERVICE_VENDAS_PERSUASIVAS_V2]
VENDA ADICIONAL É PRIORIDADE COMERCIAL.
- Sempre que houver oportunidade real e relevante durante um pedido, faça UMA tentativa persuasiva de aumentar o ticket antes da conclusão.
- A oferta deve conectar o item escolhido a um complemento real do catálogo usando combinação, conveniência, ocasião de consumo ou benefício concreto.
- Use linguagem de fechamento: torne fácil dizer sim e pergunte se pode incluir o complemento no pedido.
- Nunca invente desconto, promoção, escassez, preço, estoque, combo ou benefício.
- Em campanhas e reativação, se houver histórico de pedido, relembre a compra anterior de modo natural para demonstrar memória comercial. Depois, não se limite a repetir o pedido: consulte o catálogo atual e ofereça UM produto complementar, upgrade ou nova opção coerente para aumentar o ticket.
- Persuasão máxima com relevância e veracidade; nunca transforme a conversa em spam.
$sales$;
  v_coherence_block constant text:=$coherence$

[FOODSERVICE_CONTINUIDADE_V1]
CONTINUIDADE E IDENTIDADE — REGRA ABSOLUTA
- A MENSAGEM ATUAL do cliente é o assunto principal do turno. Histórico, resumo, memória e mensagens antigas são apenas referência; não continue espontaneamente um assunto antigo que a mensagem atual não retomou.
- Depois da primeira resposta do atendimento, responda diretamente. NÃO reinicie com "olá", "bom dia", "boa tarde" ou "boa noite" em mensagens seguintes e NÃO repita sua apresentação.
- Você é Sarah, uma agente comercial VIRTUAL do estabelecimento. Você não se desloca fisicamente, não comparece a reuniões, não chega a locais, não encontra clientes presencialmente e não promete estar fisicamente em nenhum lugar.
- Mensagens outbound do histórico podem ter sido enviadas manualmente por um atendente humano do estabelecimento. Uma frase em primeira pessoa no histórico NÃO prova que foi você quem disse ou fará aquilo. Nunca transforme ação, viagem, compromisso, relação pessoal ou agenda de um humano em ação sua.
- Se alguém perguntar se você vai fisicamente a algum lugar ou estará presencialmente em algum local, esclareça de forma natural que você é a atendente virtual e pode ajudar pelo WhatsApp. Não finja presença física.
- Não atribua ao cliente planos ou compromissos de outra pessoa.
- Não ecoe emoções, religião, intimidade ou fatos pessoais antigos se a mensagem atual não estiver falando disso. Mantenha o papel de agente comercial do estabelecimento.
$coherence$;
  v_once_block constant text:=$once$

[SAUDACAO_SOMENTE_PRIMEIRA_MENSAGEM_V3]
REGRA SOBERANA DE CONTINUIDADE DA SAUDAÇÃO
- Bom dia, boa tarde ou boa noite aparecem SOMENTE na primeira resposta da Sarah nessa conversa.
- Se já existe qualquer resposta anterior da Sarah no histórico, mesmo de outro dia, NÃO use nova saudação de horário e NÃO se apresente novamente.
- Comece diretamente pela resposta ao conteúdo atual do cliente.
- Esta regra substitui qualquer regra anterior que fale em "primeira resposta do dia" ou permita nova saudação em outro dia.
$once$;
begin
  v_neutral_pos:=position('[SAUDACAO_NEUTRA_DEMO_V1]' in v_prompt);
  if v_neutral_pos>0 then v_prompt:=rtrim(substring(v_prompt from 1 for v_neutral_pos-1)); end if;

  v_prompt:=replace(v_prompt,'Não use automaticamente o nome do contato na saudação.','Quando o nome do contato estiver disponível no contexto, use o primeiro nome na saudação inicial; nunca invente um nome.');
  v_prompt:=replace(v_prompt,'Não use bom dia, boa tarde ou boa noite. Use sempre uma saudação neutra.','Use bom dia, boa tarde ou boa noite conforme o horário local em America/Sao_Paulo, somente na primeira resposta do atendimento.');
  v_prompt:=replace(v_prompt,'Na PRIMEIRA resposta da Sarah do dia para aquele contato','Na PRIMEIRA resposta da Sarah nesta conversa para aquele contato');
  v_prompt:=replace(v_prompt,'Depois dessa primeira resposta, NÃO repita bom dia/boa tarde/boa noite nem a apresentação da Sarah no mesmo dia. Continue diretamente do ponto atual da conversa.','Depois dessa primeira resposta, NÃO repita bom dia/boa tarde/boa noite nem a apresentação da Sarah nesta conversa, mesmo em outro dia. Continue diretamente do ponto atual.');

  if position(v_named_marker in v_prompt)=0 then v_prompt:=rtrim(v_prompt)||v_named_block; end if;
  if position(v_sales_marker in v_prompt)=0 then v_prompt:=rtrim(v_prompt)||v_sales_block; end if;
  if position(v_coherence_marker in v_prompt)=0 then v_prompt:=rtrim(v_prompt)||v_coherence_block; end if;
  if position(v_once_marker in v_prompt)=0 then v_prompt:=rtrim(v_prompt)||v_once_block; end if;
  return v_prompt;
end;
$function$;

create or replace function public.fn_food_sarah_opening_v2_on_inbound()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_org_name text; v_slug text; v_tz text; v_contact_name text; v_hour int; v_period text; v_opening text;
  v_blocked boolean:=false; v_force_human boolean:=false; v_anonymized boolean:=false;
begin
  if new.direction<>'inbound' or new.contact_id is null or new.conversation_id is null or new.channel_session_id is null then return new; end if;
  if not exists(select 1 from public.food_commerce_settings f where f.organization_id=new.organization_id and f.is_enabled=true) then return new; end if;
  if not public.fn_food_conversation_ai_available(new.organization_id,new.conversation_id,new.contact_id) then return new; end if;
  if not exists(select 1 from public.channel_sessions s where s.id=new.channel_session_id and s.organization_id=new.organization_id and s.status='WORKING' and s.archived_at is null) then return new; end if;

  select coalesce(c.is_blocked,false),coalesce(c.force_human,false),coalesce(c.is_anonymized,false),nullif(btrim(split_part(c.display_name,' ',1)),'')
    into v_blocked,v_force_human,v_anonymized,v_contact_name
  from public.contacts c where c.id=new.contact_id and c.organization_id=new.organization_id;
  if v_blocked or v_force_human or v_anonymized then return new; end if;
  if v_contact_name ~ '^[+0-9(). -]+$' then v_contact_name:=null; end if;

  if exists(
    select 1 from public.messages m
    where m.organization_id=new.organization_id
      and m.conversation_id=new.conversation_id
      and m.contact_id=new.contact_id
      and m.direction='outbound'
      and m.sent_via='ai'
      and m.status<>'failed'
      and m.created_at<coalesce(new.created_at,now())
  ) then return new; end if;

  select coalesce(nullif(f.app_name,''),o.display_name),o.slug,coalesce(nullif(o.timezone,''),'America/Sao_Paulo')
    into v_org_name,v_slug,v_tz
  from public.organizations o left join public.food_commerce_settings f on f.organization_id=o.id
  where o.id=new.organization_id;
  if v_slug is null then return new; end if;

  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text||':'||new.conversation_id::text,0));

  if exists(
    select 1 from public.messages m
    where m.organization_id=new.organization_id and m.conversation_id=new.conversation_id and m.contact_id=new.contact_id
      and m.direction='outbound' and m.sent_via='ai' and m.status<>'failed'
      and m.created_at<coalesce(new.created_at,now())
  ) then return new; end if;

  v_hour:=extract(hour from (coalesce(new.sent_at,new.created_at,now()) at time zone v_tz));
  v_period:=case when v_hour between 5 and 11 then 'bom dia' when v_hour between 12 and 17 then 'boa tarde' else 'boa noite' end;
  v_opening:='Olá, '||v_period||coalesce(', '||v_contact_name,'')||'! 😊'||E'\n\n'||
    'Muito obrigado por ter entrado em contato com a '||v_org_name||'.'||E'\n\n'||
    'Meu nome é Sarah e vou te atender por aqui. Como posso te ajudar hoje?'||E'\n\n'||
    'Para acessar nosso cardápio digital, basta acessar o link abaixo:'||E'\n'||
    'https://gabarronmathias.github.io/DeskcommCRM/'||v_slug||'/';

  insert into public.messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at,metadata,created_at)
  select new.organization_id,new.conversation_id,new.channel_session_id,new.contact_id,'text','outbound','queued',v_opening,'ai',now(),
    jsonb_build_object('ai_actor_id','agent-engine-opening-v2','sarah_opening_v2',true,'deterministic_food_early',true,'reactive_outbox',true,'origin_inbound_message_id',new.id::text),now()
  where not exists(select 1 from public.messages existing where existing.organization_id=new.organization_id and existing.metadata->>'origin_inbound_message_id'=new.id::text and coalesce((existing.metadata->>'reactive_outbox')::boolean,false)=true);
  return new;
end;
$function$;

create or replace function public.fn_food_sarah_outbound_coherence()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_cleaned text; v_org_name text; v_physical_claim boolean:=false; v_has_prior_ai boolean:=false;
begin
  if new.direction<>'outbound' or new.sent_via<>'ai' or coalesce(new.body,'')='' or new.contact_id is null then return new; end if;
  if not exists(select 1 from public.food_commerce_settings f where f.organization_id=new.organization_id and f.is_enabled=true) then return new; end if;

  select coalesce(nullif(f.app_name,''),o.display_name) into v_org_name
  from public.organizations o left join public.food_commerce_settings f on f.organization_id=o.id
  where o.id=new.organization_id;

  v_physical_claim:=
       new.body ~* '(^|[^[:alpha:]])(vou|irei)[[:space:]]+(ao|à|a|na|no)[[:space:]]+'
    or new.body ~* '(^|[^[:alpha:]])estarei[[:space:]]+(no|na|aí|lá)([^[:alpha:]]|$)'
    or new.body ~* '(^|[^[:alpha:]])(quando[[:space:]]+(eu[[:space:]]+)?chegar|te[[:space:]]+aviso[[:space:]]+quando[[:space:]]+(eu[[:space:]]+)?chegar)([^[:alpha:]]|$)'
    or new.body ~* '(^|[^[:alpha:]])(te[[:space:]]+encontro|nos[[:space:]]+encontramos|estar[[:space:]]+por[[:space:]]+lá)([^[:alpha:]]|$)'
    or (new.body ~* '(^|[^[:alpha:]])estou[[:space:]]+aqui([^[:alpha:]]|$)' and new.body ~* '(^|[^[:alpha:]])(chopperia|capri|padaria|loja|estabelecimento|reunião|reuniao|lá|aí)([^[:alpha:]]|$)');
  if v_physical_claim then
    new.body:='Sou a Sarah, atendente virtual da '||coalesce(v_org_name,'empresa')||'. Não vou fisicamente a locais ou reuniões, mas posso te ajudar por aqui com cardápio, pedidos e atendimento. 😊';
    new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object('virtual_physical_claim_blocked',true);
    return new;
  end if;

  if coalesce((new.metadata->>'sarah_opening_v2')::boolean,false)=true then return new; end if;

  select exists(
    select 1 from public.messages m
    where m.organization_id=new.organization_id
      and m.conversation_id=new.conversation_id
      and m.contact_id=new.contact_id
      and m.direction='outbound' and m.sent_via='ai' and m.status<>'failed'
      and m.id is distinct from new.id
      and m.created_at<coalesce(new.created_at,now())
  ) into v_has_prior_ai;

  if v_has_prior_ai then
    v_cleaned:=regexp_replace(new.body,'^[[:space:]]*(Olá|Oi)[,!]?[[:space:]]*(bom dia|boa tarde|boa noite)(,[^!\n\r]+)?!?[[:space:]]*[😊🙂]?[[:space:]]*([\r\n]+[[:space:]]*)*','','i');
    if btrim(v_cleaned)<>'' and v_cleaned is distinct from new.body then
      new.body:=v_cleaned;
      new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object('repeated_daypart_greeting_removed',true);
    end if;
  end if;
  return new;
end;
$function$;

update public.ai_agents a
set system_prompt=public.fn_food_normalize_sarah_prompt(a.system_prompt),updated_at=now()
from public.organizations o
where a.organization_id=o.id and o.slug in ('capri','chopperia-do-gordo') and a.name='Sarah';

revoke all on function public.fn_food_sarah_opening_v2_on_inbound() from public,anon,authenticated;
grant execute on function public.fn_food_sarah_opening_v2_on_inbound() to service_role;
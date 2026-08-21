create or replace function public.fn_food_deterministic_reply(p_org uuid, p_conversation uuid, p_inbound uuid)
returns text
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_body text;
  v_sent_at timestamptz;
  v_inbound_created_at timestamptz;
  v_contact_id uuid;
  v_org_name text;
  v_contact_name text;
  v_slug text;
  v_tz text;
  v_hour int;
  v_period text;
  v_named_period text;
  v_has_prior_ai_today boolean := false;
  v_prev_outbound text;
  v_menu text;
  v_title text;
  v_price bigint;
  v_qty int;
  v_score real;
  v_same_title_count int;
  v_min_price bigint;
  v_intent text;
  v_reco text;
begin
  select m.body,m.sent_at,m.contact_id,m.created_at
    into v_body,v_sent_at,v_contact_id,v_inbound_created_at
    from public.messages m
   where m.organization_id=p_org
     and m.id=p_inbound
     and m.conversation_id=p_conversation;

  if v_contact_id is null then return null; end if;

  select coalesce(nullif(f.app_name,''),o.display_name),o.slug,coalesce(nullif(o.timezone,''),'America/Sao_Paulo')
    into v_org_name,v_slug,v_tz
    from public.organizations o
    left join public.food_commerce_settings f on f.organization_id=o.id
   where o.id=p_org;

  select nullif(btrim(split_part(c.display_name,' ',1)),'')
    into v_contact_name
    from public.contacts c
   where c.id=v_contact_id and c.organization_id=p_org;

  if v_contact_name ~ '^[+0-9(). -]+$' then
    v_contact_name := null;
  end if;

  if v_slug is null then return null; end if;

  v_menu := 'https://gabarronmathias.github.io/DeskcommCRM/'||v_slug||'/';
  v_hour := extract(hour from (coalesce(v_sent_at,v_inbound_created_at,now()) at time zone v_tz));
  v_period := case
    when v_hour between 5 and 11 then 'bom dia'
    when v_hour between 12 and 17 then 'boa tarde'
    else 'boa noite'
  end;
  v_named_period := 'Olá, '||v_period||coalesce(', '||v_contact_name,'')||'! 😊';

  select exists (
    select 1
      from public.messages m
     where m.organization_id=p_org
       and m.contact_id=v_contact_id
       and m.direction='outbound'
       and m.sent_via='ai'
       and m.status<>'failed'
       and m.created_at < v_inbound_created_at
       and (m.created_at at time zone v_tz)::date = (v_inbound_created_at at time zone v_tz)::date
  ) into v_has_prior_ai_today;

  if not v_has_prior_ai_today then
    return v_named_period||E'\n\n'||
           'Muito obrigado por ter entrado em contato com a '||v_org_name||'.'||E'\n\n'||
           'Meu nome é Sarah e vou te atender por aqui. Como posso te ajudar hoje?'||E'\n\n'||
           'Para acessar nosso cardápio digital, basta acessar o link abaixo:'||E'\n'||
           v_menu;
  end if;

  if v_body is null then return null; end if;

  select c.active_intent into v_intent
    from public.conversations c where c.id=p_conversation and c.organization_id=p_org;

  select m.body into v_prev_outbound from public.messages m
   where m.organization_id=p_org and m.conversation_id=p_conversation and m.direction='outbound'
     and m.created_at < v_inbound_created_at
   order by m.created_at desc limit 1;

  if btrim(v_body) ~* '^https?://[^[:space:]]+$' then
    return 'Recebi o link 😊. Me diga o que você gostaria que eu verificasse ou fizesse com ele.';
  end if;

  if v_body ~* '(estranh|confus|bugad|repetindo|repetiu|sem sentido|não entendi|nao entendi)' then
    return 'Entendi 😅 Obrigada por me avisar. Vou ser mais direta daqui pra frente. Como posso te ajudar agora?';
  end if;

  if v_body ~* '^[[:space:]]*(oi+|ol[aá]|bom[[:space:]]+dia|boa[[:space:]]+tarde|boa[[:space:]]+noite|e[[:space:]]*a[ií]|eai|hey|hello)[[:space:]]*[!?.]*[[:space:]]*$' then
    if v_contact_name is not null then
      return 'Olá, '||v_contact_name||'! 😊 Como posso te ajudar?';
    end if;
    return 'Olá! 😊 Como posso te ajudar?';
  end if;

  if v_body ~* '^[[:space:]]*(sim|quero|pode[[:space:]]+ser|pode[[:space:]]+mandar|manda|claro|ok|beleza|por[[:space:]]+favor|sim[[:space:]]*,?[[:space:]]*por[[:space:]]+favor)[[:space:]]*[!?.]*[[:space:]]*$' then
    if coalesce(v_prev_outbound,'') ~* '(card[aá]pio|menu)' or v_intent='awaiting_menu_choice' then
      return 'Acesse nosso cardápio digital por aqui 👇'||E'\n'||v_menu||E'\n\n'||
             'Você pode montar o seu pedido por lá. Se preferir, eu também posso te ajudar a escolher por aqui.';
    end if;
    return 'Claro! 😊 Como posso te ajudar?';
  end if;

  if v_body ~* '^[[:space:]]*(não|nao|agora[[:space:]]+não|agora[[:space:]]+nao)[[:space:]]*[!?.]*[[:space:]]*$'
     and (coalesce(v_prev_outbound,'') ~* '(card[aá]pio|menu)' or v_intent='awaiting_menu_choice') then
    return 'Sem problema! 😊 Me diga como posso te ajudar por aqui.';
  end if;

  if v_body ~* '(card[aá]pio|menu)' then
    return 'Acesse nosso cardápio digital por aqui 👇'||E'\n'||v_menu||E'\n\n'||
           'Você pode montar o seu pedido por lá. Se preferir, eu também posso te ajudar a escolher por aqui.';
  end if;

  if v_body ~* '(recomend|indica|sugest|sugere|opç|opcao|opção|para[[:space:]]+[0-9]+[[:space:]]+pessoas|[0-9]+[[:space:]]+pessoas)' then
    select string_agg(x.name, ', ' order by x.sort_order)
      into v_reco
      from (
        select p.name,p.sort_order
          from public.food_products p
         where p.organization_id=p_org
           and p.is_available=true
         order by p.sort_order,p.name
         limit 4
      ) x;
    if v_reco is not null then
      return 'Claro! 😊 Para esse grupo, eu sugiro variar entre '||v_reco||'. Todos esses itens estão disponíveis no nosso cardápio. Se quiser, eu também posso te ajudar a montar as quantidades e o valor total.';
    end if;
  end if;

  if v_body ~* '(entrega|entregam|delivery|bairro|jacare[ií]|taubat[eé]|s[aã]o[[:space:]]+jos[eé]|hor[aá]rio|abre|fecha|funciona|pagamento|pix|cart[aã]o|dinheiro|taxa|pedido[[:space:]]+m[ií]nimo|retirada|retirar)' then
    return 'Essa informação ainda não está confirmada por aqui. 😊 Posso te ajudar agora com o cardápio e os produtos; para essa regra específica, posso encaminhar sua dúvida para a equipe.';
  end if;

  select p.title,p.price_cents,p.available_qty,
         greatest(word_similarity(lower(p.title),lower(v_body)),similarity(lower(p.title),lower(v_body)))::real
    into v_title,v_price,v_qty,v_score
    from public.nuvemshop_products p where p.organization_id=p_org
   order by greatest(word_similarity(lower(p.title),lower(v_body)),similarity(lower(p.title),lower(v_body))) desc,length(p.title) desc limit 1;

  if coalesce(v_score,0) >= 0.55 then
    select count(*)::int,min(price_cents) into v_same_title_count,v_min_price
      from public.nuvemshop_products where organization_id=p_org and lower(title)=lower(v_title);
    if coalesce(v_qty,0) <= 0 then
      return v_title||' aparece no nosso cardápio, mas está indisponível no momento. 😊 Posso te mostrar outras opções?';
    elsif v_same_title_count > 1 then
      return 'Sim! 😊 '||v_title||' está no nosso cardápio a partir de R$ '||replace(to_char(v_min_price/100.0,'FM999999990D00'),'.',',')||'. Se quiser, eu te ajudo a escolher a opção ideal.';
    else
      return 'Sim! 😊 '||v_title||' está no nosso cardápio por R$ '||replace(to_char(v_price/100.0,'FM999999990D00'),'.',',')||'. Se quiser, eu também posso te ajudar a escolher outros itens.';
    end if;
  end if;

  return null;
end;
$function$;

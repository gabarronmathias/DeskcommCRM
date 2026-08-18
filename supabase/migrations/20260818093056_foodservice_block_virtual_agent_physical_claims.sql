create or replace function public.fn_food_sarah_outbound_coherence()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_tz text;
  v_day date;
  v_has_prior_ai boolean:=false;
  v_cleaned text;
  v_org_name text;
  v_physical_claim boolean:=false;
begin
  if new.direction<>'outbound' or new.sent_via<>'ai' or coalesce(new.body,'')='' or new.contact_id is null then return new; end if;
  if not exists(select 1 from public.food_commerce_settings f where f.organization_id=new.organization_id and f.is_enabled=true) then return new; end if;

  select coalesce(nullif(o.timezone,''),'America/Sao_Paulo'),coalesce(nullif(f.app_name,''),o.display_name)
    into v_tz,v_org_name
  from public.organizations o left join public.food_commerce_settings f on f.organization_id=o.id
  where o.id=new.organization_id;

  -- Sarah e uma agente virtual: alegacoes em primeira pessoa de presenca/deslocamento fisico
  -- sao falsas para este produto e devem ser neutralizadas antes do envio.
  v_physical_claim :=
       new.body ~* '(^|[^[:alpha:]])(vou|irei)[[:space:]]+(ao|à|a|na|no)[[:space:]]+'
    or new.body ~* '(^|[^[:alpha:]])estarei[[:space:]]+(no|na|aí|lá)([^[:alpha:]]|$)'
    or new.body ~* '(^|[^[:alpha:]])(quando[[:space:]]+(eu[[:space:]]+)?chegar|te[[:space:]]+aviso[[:space:]]+quando[[:space:]]+(eu[[:space:]]+)?chegar)([^[:alpha:]]|$)'
    or new.body ~* '(^|[^[:alpha:]])(te[[:space:]]+encontro|nos[[:space:]]+encontramos|estar[[:space:]]+por[[:space:]]+lá)([^[:alpha:]]|$)'
    or (new.body ~* '(^|[^[:alpha:]])estou[[:space:]]+aqui([^[:alpha:]]|$)'
        and new.body ~* '(^|[^[:alpha:]])(chopperia|capri|padaria|loja|estabelecimento|reunião|reuniao|lá|aí)([^[:alpha:]]|$)');

  if v_physical_claim then
    new.body := 'Sou a Sarah, atendente virtual da '||coalesce(v_org_name,'empresa')||'. Não vou fisicamente a locais ou reuniões, mas posso te ajudar por aqui com cardápio, pedidos e atendimento. 😊';
    new.metadata := coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object('virtual_physical_claim_blocked',true);
    return new;
  end if;

  if coalesce((new.metadata->>'sarah_opening_v2')::boolean,false)=true then return new; end if;

  v_day := (coalesce(new.created_at,now()) at time zone v_tz)::date;
  select exists(
    select 1 from public.messages m
    where m.organization_id=new.organization_id and m.contact_id=new.contact_id
      and m.direction='outbound' and m.sent_via='ai' and m.status<>'failed'
      and m.id is distinct from new.id
      and m.created_at < coalesce(new.created_at,now())
      and (m.created_at at time zone v_tz)::date=v_day
  ) into v_has_prior_ai;

  if v_has_prior_ai then
    v_cleaned := regexp_replace(new.body,
      '^[[:space:]]*(Olá|Oi)[,!]?[[:space:]]*(bom dia|boa tarde|boa noite)(,[^!\n\r]+)?!?[[:space:]]*[😊🙂]?[[:space:]]*([\r\n]+[[:space:]]*)*',
      '','i');
    if btrim(v_cleaned)<>'' and v_cleaned is distinct from new.body then
      new.body:=v_cleaned;
      new.metadata:=coalesce(new.metadata,'{}'::jsonb)||jsonb_build_object('repeated_daypart_greeting_removed',true);
    end if;
  end if;
  return new;
end;
$function$;
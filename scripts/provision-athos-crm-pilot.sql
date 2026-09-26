-- Idempotent data provisioning for the isolated Athos homologation tenant.
-- No credentials, partner bearer tokens or real customer phone numbers live here.

begin;

do $$
declare
  v_connection_id uuid;
  v_store_ref text := '5b7b4a38-4c54-488e-986f-9ea0428cff7a';
  v_org_id uuid;
  v_session_id uuid;
  v_contact_id uuid;
  v_conversation_id uuid;
  v_session_name text;
  v_launch_id uuid := 'd8a86b8f-7d36-4e6e-9dd1-8a9b1b8db8e1';
begin
  select id into v_connection_id
  from public.athos_sandbox_connections
  where store_ref = v_store_ref
    and environment = 'sandbox'
    and active = true
    and revoked_at is null;

  if v_connection_id is null then
    raise exception 'athos_active_sandbox_connection_not_found';
  end if;

  select id into v_org_id
  from public.organizations
  where slug = 'athos-piloto-tortas-do-calmon';

  if v_org_id is null then
    insert into public.organizations (
      slug,
      legal_name,
      display_name,
      status,
      timezone,
      locale,
      settings,
      onboarded_at
    ) values (
      'athos-piloto-tortas-do-calmon',
      'Athos Piloto — Tortas do Calmon',
      'Athos Piloto — Tortas do Calmon',
      'active',
      'America/Sao_Paulo',
      'pt-BR',
      jsonb_build_object(
        'plan', 'pilot',
        'branding', jsonb_build_object(
          'app_name', 'Athos Piloto — Tortas do Calmon',
          'accent_hex', '#B88632'
        ),
        'integration', jsonb_build_object(
          'athos', jsonb_build_object(
            'environment', 'sandbox',
            'store_ref', v_store_ref
          )
        )
      ),
      now()
    ) returning id into v_org_id;
  end if;

  v_session_name := 'org_' || left(v_org_id::text, 8);

  select id into v_session_id
  from public.channel_sessions
  where organization_id = v_org_id
    and waha_session_name = v_session_name
    and archived_at is null;

  if v_session_id is null then
    insert into public.channel_sessions (
      organization_id,
      waha_session_name,
      display_name,
      engine,
      webhook_path_token,
      webhook_secret_encrypted,
      status,
      last_status_change_at,
      consecutive_health_fails,
      daily_message_limit,
      metadata
    ) values (
      v_org_id,
      v_session_name,
      'WhatsApp Athos Piloto',
      'NOWEB',
      replace(gen_random_uuid()::text, '-', ''),
      decode('00', 'hex'),
      'STOPPED',
      now(),
      0,
      50,
      jsonb_build_object('purpose', 'athos_partner_homologation', 'real_customer_data', false)
    ) returning id into v_session_id;
  end if;

  select id into v_contact_id
  from public.contacts
  where organization_id = v_org_id
    and phone_number = '+5511999999999'
    and is_merged_into is null;

  if v_contact_id is null then
    insert into public.contacts (
      organization_id,
      name,
      display_name,
      phone_number,
      source,
      source_metadata,
      tags
    ) values (
      v_org_id,
      'Cliente Homologação Athos',
      'Cliente Homologação Athos',
      '+5511999999999',
      'manual',
      jsonb_build_object('purpose', 'athos_partner_homologation', 'synthetic', true),
      array['athos-pilot', 'synthetic']::text[]
    ) returning id into v_contact_id;
  end if;

  select id into v_conversation_id
  from public.conversations
  where organization_id = v_org_id
    and contact_id = v_contact_id
    and channel_session_id = v_session_id
    and is_group = false;

  if v_conversation_id is null then
    insert into public.conversations (
      organization_id,
      contact_id,
      channel_session_id,
      channel,
      status,
      metadata,
      tags
    ) values (
      v_org_id,
      v_contact_id,
      v_session_id,
      'whatsapp',
      'open',
      jsonb_build_object('purpose', 'athos_partner_homologation', 'synthetic', true),
      array['athos-pilot']::text[]
    ) returning id into v_conversation_id;
  end if;

  insert into public.food_commerce_settings (
    organization_id,
    app_name,
    tagline,
    headline,
    description,
    is_enabled,
    settings
  ) values (
    v_org_id,
    'Tortas do Calmon — Homologação',
    'Sarah + CRM + Athos',
    'Ambiente isolado de homologação',
    'Dados sintéticos para validar o fluxo ponta a ponta com a Athos.',
    true,
    jsonb_build_object(
      'athos_menu_url', 'https://cardapio.sistemaathos.com.br/tortasdocalmon',
      'environment', 'sandbox'
    )
  )
  on conflict (organization_id) do update set
    app_name = excluded.app_name,
    tagline = excluded.tagline,
    headline = excluded.headline,
    description = excluded.description,
    is_enabled = excluded.is_enabled,
    settings = excluded.settings,
    updated_at = now();

  insert into public.ai_agents (
    organization_id,
    name,
    description,
    is_active,
    is_default,
    model,
    system_prompt,
    kind,
    priority
  ) values (
    v_org_id,
    'Sarah — Athos Piloto',
    'Agente de relacionamento e vendas do piloto de integração com a Athos.',
    false,
    true,
    'gpt-4.1-mini',
    'Você é Sarah, agente de relacionamento e vendas do ambiente de homologação Athos. Use somente dados sintéticos. Encaminhe o cliente ao cardápio Tortas do Calmon e preserve a correlação de contato, conversa e pedido.',
    'rag_bot',
    100
  )
  on conflict (organization_id, name) do update set
    description = excluded.description,
    is_active = false,
    is_default = true,
    system_prompt = excluded.system_prompt,
    updated_at = now();

  insert into public.athos_sandbox_tenant_bindings (
    connection_id,
    organization_id,
    channel_session_id,
    active
  ) values (
    v_connection_id,
    v_org_id,
    v_session_id,
    true
  )
  on conflict (connection_id) do update set
    organization_id = excluded.organization_id,
    channel_session_id = excluded.channel_session_id,
    active = true,
    updated_at = now();

  insert into public.athos_sandbox_launches (
    launch_id,
    connection_id,
    store_ref,
    crm_contact_id,
    crm_conversation_id,
    customer_display_name,
    customer_phone,
    expires_at
  ) values (
    v_launch_id,
    v_connection_id,
    v_store_ref,
    v_contact_id,
    v_conversation_id,
    'Cliente Homologação Athos',
    '+5511999999999',
    now() + interval '30 days'
  )
  on conflict (launch_id) do update set
    connection_id = excluded.connection_id,
    store_ref = excluded.store_ref,
    crm_contact_id = excluded.crm_contact_id,
    crm_conversation_id = excluded.crm_conversation_id,
    customer_display_name = excluded.customer_display_name,
    customer_phone = excluded.customer_phone,
    expires_at = excluded.expires_at;
end;
$$;

commit;

select jsonb_build_object(
  'tenant', (
    select jsonb_build_object('id', id, 'slug', slug, 'display_name', display_name)
    from public.organizations
    where slug = 'athos-piloto-tortas-do-calmon'
  ),
  'channel', (
    select jsonb_build_object('id', id, 'session', waha_session_name, 'status', status)
    from public.channel_sessions
    where organization_id = (
      select id from public.organizations where slug = 'athos-piloto-tortas-do-calmon'
    ) and archived_at is null
    order by created_at
    limit 1
  ),
  'launch', (
    select jsonb_build_object(
      'launch_id', launch_id,
      'contact_id', crm_contact_id,
      'conversation_id', crm_conversation_id,
      'expires_at', expires_at
    )
    from public.athos_sandbox_launches
    where launch_id = 'd8a86b8f-7d36-4e6e-9dd1-8a9b1b8db8e1'
  )
) as pilot;

-- Rollback versionado da migration 0184. Restaura o checkout anterior à taxa estruturada.
create or replace function public.fn_food_checkout(
  p_tenant_slug text,
  p_idempotency_key text,
  p_session_key text,
  p_customer_name text,
  p_phone text,
  p_fulfillment text,
  p_payment_method text,
  p_address_notes text,
  p_marketing_consent boolean,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $$
declare
  v_org_id uuid;
  v_phone text;
  v_contact_id uuid;
  v_order_id uuid;
  v_external_id text;
  v_total bigint := 0;
  v_item jsonb;
  v_product record;
  v_qty integer;
  v_modifier_ids uuid[];
  v_modifier_count integer;
  v_matched_modifier_count integer;
  v_modifier_delta bigint;
  v_modifier_snapshot jsonb;
  v_group record;
  v_group_selected integer;
  v_rule_id uuid;
  v_trigger_product_id uuid;
  v_line_total bigint;
  v_request_hash bytea;
  v_request_payload jsonb;
  v_existing record;
  v_result jsonb;
  v_item_seq integer := 0;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 or length(trim(p_idempotency_key)) > 128 then
    raise exception 'idempotency_key_invalid' using errcode = '22023';
  end if;
  if p_session_key is null or length(trim(p_session_key)) < 6 or length(trim(p_session_key)) > 160 then
    raise exception 'session_key_invalid' using errcode = '22023';
  end if;
  if nullif(trim(p_customer_name), '') is null or length(trim(p_customer_name)) > 160 then
    raise exception 'customer_name_invalid' using errcode = '22023';
  end if;
  if lower(trim(p_fulfillment)) not in ('retirada','entrega') then
    raise exception 'fulfillment_invalid' using errcode = '22023';
  end if;
  if lower(trim(p_payment_method)) not in ('pix','cartao','cartão','dinheiro') then
    raise exception 'payment_method_invalid' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'items_invalid' using errcode = '22023';
  end if;

  select o.id into v_org_id
  from public.organizations o
  join public.food_commerce_settings s on s.organization_id = o.id
  where o.slug::text = lower(trim(p_tenant_slug))
    and o.status = 'active'
    and s.is_enabled = true;
  if v_org_id is null then
    raise exception 'food_tenant_not_found' using errcode = 'P0002';
  end if;

  v_phone := public.fn_food_normalize_phone(p_phone);
  v_request_payload := jsonb_build_object(
    'tenant_slug', lower(trim(p_tenant_slug)),
    'session_key', trim(p_session_key),
    'customer_name', trim(p_customer_name),
    'phone', v_phone,
    'fulfillment', lower(trim(p_fulfillment)),
    'payment_method', lower(trim(p_payment_method)),
    'address_notes', coalesce(p_address_notes, ''),
    'marketing_consent', coalesce(p_marketing_consent, false),
    'items', p_items
  );
  v_request_hash := digest(convert_to(v_request_payload::text, 'UTF8'), 'sha256');

  perform pg_advisory_xact_lock(hashtextextended(v_org_id::text || ':' || trim(p_idempotency_key), 0));
  select request_hash, response_body, expires_at into v_existing
  from public.idempotency_keys
  where organization_id=v_org_id
    and key=trim(p_idempotency_key)
    and endpoint='food_checkout';

  if found and v_existing.expires_at > now() then
    if v_existing.request_hash <> v_request_hash then
      raise exception 'idempotency_key_conflict' using errcode='23505';
    end if;
    return v_existing.response_body;
  elsif found then
    delete from public.idempotency_keys
    where organization_id=v_org_id
      and key=trim(p_idempotency_key)
      and endpoint='food_checkout';
  end if;

  select c.id into v_contact_id
  from public.contacts c
  where c.organization_id=v_org_id
    and c.phone_number=v_phone
    and c.is_merged_into is null
  limit 1;

  if v_contact_id is null then
    insert into public.contacts (
      organization_id,name,display_name,phone_number,source,source_metadata
    ) values (
      v_org_id,trim(p_customer_name),trim(p_customer_name),v_phone,
      'food_commerce',
      jsonb_build_object('tenant_slug',lower(trim(p_tenant_slug)),'first_order_session',trim(p_session_key))
    )
    on conflict do nothing
    returning id into v_contact_id;

    if v_contact_id is null then
      select c.id into v_contact_id
      from public.contacts c
      where c.organization_id=v_org_id
        and (c.phone_number=v_phone or c.wa_identity='phone:' || v_phone)
        and c.is_merged_into is null
      limit 1;
    end if;
  else
    update public.contacts
      set name=coalesce(name,trim(p_customer_name)),
          display_name=coalesce(display_name,trim(p_customer_name)),
          updated_at=now()
      where id=v_contact_id;
  end if;

  if v_contact_id is null then
    raise exception 'contact_resolution_failed';
  end if;

  if coalesce(p_marketing_consent,false) then
    update public.contacts
    set consent=jsonb_set(
          consent,
          '{marketing}',
          jsonb_build_object('granted_at',now(),'source','food_checkout','version','v1'),
          true
        ),
        updated_at=now()
    where id=v_contact_id;
  end if;

  v_external_id := trim(p_idempotency_key);
  insert into public.orders (
    organization_id,external_id,external_provider,customer_external_id,
    contact_id,status,total_cents,currency,payment_method,fulfillment_status,
    payload,ordered_at,updated_at_remote
  ) values (
    v_org_id,v_external_id,'deskcomm_food',v_phone,v_contact_id,'pending',0,'BRL',
    case when lower(trim(p_payment_method)) in ('cartao','cartão') then 'cartao'
         else lower(trim(p_payment_method)) end,
    null,
    jsonb_build_object(
      'source','food_commerce',
      'session_key',trim(p_session_key),
      'fulfillment',lower(trim(p_fulfillment)),
      'address_notes',coalesce(p_address_notes,''),
      'marketing_consent_at_checkout',coalesce(p_marketing_consent,false)
    ),
    now(),now()
  ) returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_item_seq := v_item_seq + 1;

    begin
      v_qty := coalesce((v_item->>'quantity')::integer,0);
    exception when others then
      raise exception 'item_quantity_invalid:%',v_item_seq using errcode='22023';
    end;
    if v_qty < 1 or v_qty > 99 then
      raise exception 'item_quantity_invalid:%',v_item_seq using errcode='22023';
    end if;

    begin
      select p.id,p.name,p.price_cents into v_product
      from public.food_products p
      where p.id=(v_item->>'product_id')::uuid
        and p.organization_id=v_org_id
        and p.is_available=true;
    exception when invalid_text_representation then
      raise exception 'product_id_invalid:%',v_item_seq using errcode='22023';
    end;
    if not found then
      raise exception 'product_not_available:%',v_item_seq using errcode='P0002';
    end if;

    begin
      select coalesce(array_agg(x.id order by x.id),'{}'::uuid[]),count(*)
        into v_modifier_ids,v_modifier_count
      from (
        select (value #>> '{}')::uuid as id
        from jsonb_array_elements(coalesce(v_item->'modifier_ids','[]'::jsonb))
      ) x;
    exception when others then
      raise exception 'modifier_ids_invalid:%',v_item_seq using errcode='22023';
    end;

    if coalesce(array_length(v_modifier_ids,1),0)
      <> coalesce((select count(distinct x) from unnest(v_modifier_ids) x),0) then
      raise exception 'modifier_duplicate:%',v_item_seq using errcode='22023';
    end if;

    select count(*),coalesce(sum(m.price_delta_cents),0),
           coalesce(jsonb_agg(jsonb_build_object(
             'id',m.id,'name',m.name,'group_id',g.id,'group_name',g.name,
             'price_delta_cents',m.price_delta_cents
           ) order by g.sort_order,m.sort_order,m.name),'[]'::jsonb)
      into v_matched_modifier_count,v_modifier_delta,v_modifier_snapshot
    from public.food_modifiers m
    join public.food_modifier_groups g
      on g.id=m.group_id and g.organization_id=m.organization_id
    where m.organization_id=v_org_id
      and g.product_id=v_product.id
      and g.is_active=true
      and m.is_available=true
      and m.id=any(v_modifier_ids);

    if v_matched_modifier_count <> v_modifier_count then
      raise exception 'modifier_not_available:%',v_item_seq using errcode='P0002';
    end if;

    for v_group in
      select g.id,g.name,g.min_select,g.max_select,g.is_required
      from public.food_modifier_groups g
      where g.organization_id=v_org_id
        and g.product_id=v_product.id
        and g.is_active=true
    loop
      select count(*) into v_group_selected
      from public.food_modifiers m
      where m.organization_id=v_org_id
        and m.group_id=v_group.id
        and m.id=any(v_modifier_ids);

      if v_group_selected < greatest(v_group.min_select,case when v_group.is_required then 1 else 0 end)
         or v_group_selected > v_group.max_select then
        raise exception 'modifier_group_selection_invalid:%:%',v_item_seq,v_group.name using errcode='22023';
      end if;
    end loop;

    v_rule_id := null;
    v_trigger_product_id := null;
    if nullif(v_item->>'recommendation_rule_id','') is not null then
      begin
        v_rule_id := (v_item->>'recommendation_rule_id')::uuid;
      exception when invalid_text_representation then
        raise exception 'recommendation_rule_invalid:%',v_item_seq using errcode='22023';
      end;

      select r.trigger_product_id into v_trigger_product_id
      from public.food_recommendation_rules r
      where r.id=v_rule_id
        and r.organization_id=v_org_id
        and r.is_active=true
        and r.recommended_product_id=v_product.id
        and r.kind in ('upsell','cross_sell','upgrade','combo','order_bump')
        and (
          r.trigger_product_id is null
          or exists (
            select 1 from jsonb_array_elements(p_items) source_item
            where source_item->>'product_id'=r.trigger_product_id::text
          )
        );
      if not found then
        raise exception 'recommendation_rule_invalid:%',v_item_seq using errcode='22023';
      end if;
    end if;

    v_line_total := (v_product.price_cents + v_modifier_delta) * v_qty;
    if v_line_total < 0 then
      raise exception 'line_total_invalid:%',v_item_seq using errcode='22023';
    end if;
    v_total := v_total + v_line_total;

    insert into public.food_order_items (
      organization_id,order_id,product_id,product_name_snapshot,
      unit_price_cents,quantity,line_total_cents,selected_modifiers,
      added_via_recommendation,recommendation_rule_id
    ) values (
      v_org_id,v_order_id,v_product.id,v_product.name,
      v_product.price_cents+v_modifier_delta,v_qty,v_line_total,v_modifier_snapshot,
      v_rule_id is not null,v_rule_id
    );

    if v_rule_id is not null then
      insert into public.food_recommendation_events (
        organization_id,session_key,rule_id,trigger_product_id,recommended_product_id,
        order_id,event_type,attributed_revenue_cents,metadata
      ) values (
        v_org_id,trim(p_session_key),v_rule_id,v_trigger_product_id,v_product.id,
        v_order_id,'purchased',v_line_total,
        jsonb_build_object('quantity',v_qty,'source','food_checkout')
      );
    end if;
  end loop;

  update public.orders
    set total_cents=v_total,
        payload=payload || jsonb_build_object('server_calculated_total_cents',v_total),
        updated_at=now()
    where id=v_order_id;

  perform public.emit_event(
    'order.created','order',v_order_id,
    jsonb_build_object(
      'order_id',v_order_id,
      'contact_id',v_contact_id,
      'total_cents',v_total,
      'external_provider','deskcomm_food',
      'session_key',trim(p_session_key),
      'fulfillment',lower(trim(p_fulfillment))
    ),
    jsonb_build_object('source','food_checkout','idempotency_key',trim(p_idempotency_key)),
    v_org_id
  );

  select jsonb_build_object(
    'order_id',v_order_id,
    'external_id',v_external_id,
    'contact_id',v_contact_id,
    'status','pending',
    'total_cents',v_total,
    'currency','BRL'
  ) into v_result;

  insert into public.idempotency_keys (
    organization_id,key,endpoint,request_hash,status_code,response_body,expires_at
  ) values (
    v_org_id,trim(p_idempotency_key),'food_checkout',v_request_hash,201,v_result,now()+interval '24 hours'
  );

  return v_result;
end;
$$;
REVOKE EXECUTE ON FUNCTION public.fn_food_checkout(text,text,text,text,text,text,text,text,boolean,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_food_checkout(text,text,text,text,text,text,text,text,boolean,jsonb)
  TO service_role;

DROP FUNCTION IF EXISTS public.fn_food_delivery_quote(jsonb,jsonb,bigint,text,text,timestamptz);

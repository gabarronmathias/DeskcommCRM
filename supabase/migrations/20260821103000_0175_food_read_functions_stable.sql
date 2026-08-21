-- Estas RPCs apenas leem dados. Sem a declaração explícita, PostgreSQL as
-- classifica como VOLATILE e o gate de SECURITY DEFINER corretamente as trata
-- como funções potencialmente capazes de escrever.
alter function public.fn_food_public_catalog(text) stable;
alter function public.fn_food_delivery_report(uuid,timestamptz,timestamptz) stable;

revoke execute on function public.fn_food_public_catalog(text)
  from public, anon, authenticated;
grant execute on function public.fn_food_public_catalog(text) to service_role;

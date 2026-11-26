-- Restore organization UUID generation and the default CRM pipeline seed.
-- The supported self-hosted baseline defines both; production drift removed them.
BEGIN;

ALTER TABLE public.organizations
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

CREATE OR REPLACE FUNCTION public.fn_seed_default_pipeline_for_org()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_pipeline_id uuid;
  v_position numeric := 1000;
  r record;
BEGIN
  INSERT INTO public.crm_pipelines (organization_id, name, slug, is_default, position)
  VALUES (NEW.id, 'Pedidos', 'pedidos', true, 1000)
  RETURNING id INTO v_pipeline_id;

  FOR r IN
    SELECT * FROM (VALUES
      ('Carrinho abandonado',  'carrinho_abandonado',  false, false),
      ('Aguardando pagamento', 'aguardando_pagamento', false, false),
      ('Pago',                 'pago',                 true,  false),
      ('Em separação',         'em_separacao',         false, false),
      ('Enviado',              'enviado',              false, false),
      ('Entregue',             'entregue',             false, false),
      ('Pós-venda',            'pos_venda',            false, false),
      ('Cancelado',            'cancelado',            false, true)
    ) AS t(stage_name, stage_slug, won, lost)
  LOOP
    INSERT INTO public.crm_stages (
      organization_id, pipeline_id, name, slug, position, is_won, is_lost
    )
    VALUES (
      NEW.id, v_pipeline_id, r.stage_name, r.stage_slug, v_position, r.won, r.lost
    );
    v_position := v_position + 1000;
  END LOOP;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.fn_seed_default_pipeline_for_org() OWNER TO postgres;
GRANT ALL ON FUNCTION public.fn_seed_default_pipeline_for_org() TO anon;
GRANT ALL ON FUNCTION public.fn_seed_default_pipeline_for_org() TO authenticated;
GRANT ALL ON FUNCTION public.fn_seed_default_pipeline_for_org() TO service_role;

DROP TRIGGER IF EXISTS trg_seed_default_pipeline_for_org ON public.organizations;
CREATE TRIGGER trg_seed_default_pipeline_for_org
  AFTER INSERT ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_seed_default_pipeline_for_org();

COMMIT;

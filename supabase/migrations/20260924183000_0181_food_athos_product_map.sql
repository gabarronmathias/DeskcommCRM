-- Mapping between CRM food product slugs and Athos product UUIDs.
-- Matches the schema delivered in the food-service v107 backup.
CREATE TABLE IF NOT EXISTS public.food_athos_product_map (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  external_product_id text NOT NULL,
  athos_product_id uuid NOT NULL,
  athos_product_name text NOT NULL,
  athos_unit_price_cents bigint,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, external_product_id)
);

CREATE INDEX IF NOT EXISTS idx_food_athos_product_map_org
  ON public.food_athos_product_map (organization_id);
CREATE INDEX IF NOT EXISTS idx_food_athos_product_map_athos_id
  ON public.food_athos_product_map (athos_product_id);

ALTER TABLE public.food_athos_product_map ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.food_athos_product_map FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.food_athos_product_map TO service_role;

COMMENT ON TABLE public.food_athos_product_map IS
  'Mapping from the CRM product slug to its Athos product UUID.';

CREATE OR REPLACE FUNCTION public.food_athos_product_map_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_food_athos_product_map_touch ON public.food_athos_product_map;
CREATE TRIGGER trg_food_athos_product_map_touch
  BEFORE UPDATE ON public.food_athos_product_map
  FOR EACH ROW EXECUTE FUNCTION public.food_athos_product_map_touch_updated_at();

CREATE OR REPLACE VIEW public.food_athos_product_resolved AS
SELECT
  m.organization_id,
  m.external_product_id,
  m.athos_product_id,
  m.athos_product_name,
  m.athos_unit_price_cents,
  m.last_synced_at,
  (SELECT fp.name FROM public.food_products fp
    WHERE fp.organization_id = m.organization_id
      AND fp.external_product_id = m.external_product_id
    LIMIT 1) AS internal_product_name
FROM public.food_athos_product_map m;

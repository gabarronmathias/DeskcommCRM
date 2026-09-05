-- Migration 20260905173000 — GB Command Center: controles operacionais
-- Cria tabela singleton (1 linha por org) com flags de pausa.
-- O dispatcher consulta ANTES de cada envio. NAO bypassa regras (campaign,
-- business hours, daily limit, checkPhoneExists continuam hard).

CREATE TABLE IF NOT EXISTS public.command_center_state (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  prospecting_paused boolean NOT NULL DEFAULT false,
  outbound_paused boolean NOT NULL DEFAULT false,
  emergency_stop boolean NOT NULL DEFAULT false,
  paused_by uuid REFERENCES auth.users(id),
  paused_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.command_center_state IS
  'Estado operacional da GB Command Center. 1 linha por org. Flags de pausa: se true, dispatcher no-op.';

-- RLS: membros da org podem ler; apenas platform_admin ou membros com role manager+ podem alterar.
ALTER TABLE public.command_center_state ENABLE ROW LEVEL SECURITY;

-- Politica: cada org ve apenas a sua linha (mesma logica de outras tabelas)
DROP POLICY IF EXISTS command_center_state_select ON public.command_center_state;
CREATE POLICY command_center_state_select ON public.command_center_state
  FOR SELECT USING (
    organization_id = (SELECT active_org_id FROM public.current_session())
    OR (SELECT is_platform_admin()) = true
  );

DROP POLICY IF EXISTS command_center_state_update ON public.command_center_state;
CREATE POLICY command_center_state_update ON public.command_center_state
  FOR UPDATE USING (
    organization_id = (SELECT active_org_id FROM public.current_session())
  )
  WITH CHECK (
    organization_id = (SELECT active_org_id FROM public.current_session())
  );

-- Inserir linha para a org gabarron-mathias se ainda nao existir
INSERT INTO public.command_center_state (organization_id)
SELECT id FROM public.organizations WHERE slug = 'gabarron-mathias'
ON CONFLICT (organization_id) DO NOTHING;

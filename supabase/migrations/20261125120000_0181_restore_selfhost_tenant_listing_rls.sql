-- 0181_restore_selfhost_tenant_listing_rls
-- Repair schema drift on the self-hosted production database.
-- The existing rows are retained; the FK is only added after validating that
-- every conversation points at an existing organization.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.conversations c
    LEFT JOIN public.organizations o ON o.id = c.organization_id
    WHERE c.organization_id IS NULL OR o.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot restore conversations organization FK: null or orphan organization_id exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.conversations'::regclass
      AND conname = 'conversations_organization_id_fkey'
      AND contype = 'f'
  ) THEN
    ALTER TABLE public.conversations
      ADD CONSTRAINT conversations_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
      ON DELETE CASCADE;
  END IF;
END;
$$;

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orgs_select ON public.organizations;
CREATE POLICY orgs_select ON public.organizations
  FOR SELECT TO authenticated
  USING (
    id IN (SELECT public.fn_user_org_ids())
    OR public.fn_is_platform_admin()
  );
DROP POLICY IF EXISTS orgs_write_platform_admin ON public.organizations;
CREATE POLICY orgs_write_platform_admin ON public.organizations
  FOR ALL TO authenticated
  USING (public.fn_is_platform_admin())
  WITH CHECK (public.fn_is_platform_admin());

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversations_tenant_isolation_all ON public.conversations;
DROP POLICY IF EXISTS conversations_agent_write ON public.conversations;
DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations
  FOR SELECT TO authenticated
  USING (public.fn_can_view_conversation(organization_id, assigned_to_user_id));
DROP POLICY IF EXISTS conversations_agent_insert ON public.conversations;
CREATE POLICY conversations_agent_insert ON public.conversations
  FOR INSERT TO authenticated
  WITH CHECK (
    public.fn_is_platform_admin()
    OR (
      organization_id IN (SELECT public.fn_user_org_ids())
      AND public.fn_role_at_least(organization_id, 'agent')
    )
  );
DROP POLICY IF EXISTS conversations_agent_update ON public.conversations;
CREATE POLICY conversations_agent_update ON public.conversations
  FOR UPDATE TO authenticated
  USING (
    public.fn_is_platform_admin()
    OR (
      organization_id IN (SELECT public.fn_user_org_ids())
      AND public.fn_role_at_least(organization_id, 'agent')
    )
  )
  WITH CHECK (
    public.fn_is_platform_admin()
    OR (
      organization_id IN (SELECT public.fn_user_org_ids())
      AND public.fn_role_at_least(organization_id, 'agent')
    )
  );
DROP POLICY IF EXISTS conversations_agent_delete ON public.conversations;
CREATE POLICY conversations_agent_delete ON public.conversations
  FOR DELETE TO authenticated
  USING (
    public.fn_is_platform_admin()
    OR (
      organization_id IN (SELECT public.fn_user_org_ids())
      AND public.fn_role_at_least(organization_id, 'agent')
    )
  );

ALTER TABLE public.channel_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_sessions_tenant_isolation_all ON public.channel_sessions;
DROP POLICY IF EXISTS channel_sessions_tenant_select ON public.channel_sessions;
CREATE POLICY channel_sessions_tenant_select ON public.channel_sessions
  FOR SELECT TO authenticated
  USING (
    organization_id IN (SELECT public.fn_user_org_ids())
    OR public.fn_is_platform_admin()
  );
DROP POLICY IF EXISTS channel_sessions_tenant_write ON public.channel_sessions;
CREATE POLICY channel_sessions_tenant_write ON public.channel_sessions
  FOR ALL TO authenticated
  USING (
    (
      organization_id IN (SELECT public.fn_user_org_ids())
      AND public.fn_role_at_least(organization_id, 'admin')
    )
    OR public.fn_is_platform_admin()
  )
  WITH CHECK (
    (
      organization_id IN (SELECT public.fn_user_org_ids())
      AND public.fn_role_at_least(organization_id, 'admin')
    )
    OR public.fn_is_platform_admin()
  );

-- These Athos tables are not used by the CRM application. In particular,
-- athos_store_config contains the sensitive cardapio_api_key column. The
-- internal service_role retains its existing privileges and bypasses RLS.
DO $$
BEGIN
  IF to_regclass('public.athos_store_config') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.athos_store_config ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON TABLE public.athos_store_config FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regclass('public.athos_store_products') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.athos_store_products ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON TABLE public.athos_store_products FROM PUBLIC, anon, authenticated';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

import { ensureScope, McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export type AthosScope = "athos:launch:read" | "athos:events:write";

export async function authenticateAthosPartner(authorization: string | null, scope: AthosScope) {
  const auth = await validateBearerToken(authorization);
  ensureScope(auth.scopes, scope);
  const admin = createAdminClient();
  const { data: integration, error } = await admin
    .from("tenant_integrations")
    .select("id, organization_id, partner_api_token_id, webhook_secret_encrypted, status, store_metadata")
    .eq("organization_id", auth.organizationId)
    .eq("provider", "athos")
    .eq("partner_api_token_id", auth.apiTokenId)
    .maybeSingle();

  if (error || !integration || integration.status !== "healthy") {
    throw new McpAuthError(-32001, 401, "Athos integration is not active for this token.");
  }
  const metadata = integration.store_metadata as Record<string, unknown> | null;
  if (metadata?.environment !== "sandbox") {
    throw new McpAuthError(-32002, 403, "This endpoint is currently restricted to the Athos sandbox.");
  }
  const storeRef = typeof metadata.store_ref === "string" ? metadata.store_ref : "";
  if (!storeRef) throw new McpAuthError(-32603, 500, "Athos store is not configured.");

  return { auth, admin, integration, storeRef };
}

import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Correlates an Athos menu checkout with the CRM conversation. Only rewrites
 * the configured Athos menu URL; arbitrary links in Sarah's answer are untouched.
 */
export async function attachAthosLaunchToMenuLink(input: {
  pool: pg.Pool;
  organizationId: string;
  contactId: string;
  conversationId: string;
  body: string;
  requestId: string;
}): Promise<string> {
  if (!input.body.includes("cardapio.sistemaathos.com.br")) return input.body;
  const integration = await input.pool.query<{ store_metadata: Record<string, unknown> }>(
    `select store_metadata
       from tenant_integrations
      where organization_id = $1 and provider = 'athos' and status = 'healthy'
      limit 1`,
    [input.organizationId],
  );
  const metadata = integration.rows[0]?.store_metadata;
  if (metadata?.environment !== "sandbox" || typeof metadata.menu_url !== "string" || metadata.menu_url === "") {
    return input.body;
  }
  if (!input.body.includes(metadata.menu_url)) return input.body;

  const menuUrl = new URL(metadata.menu_url);
  if (menuUrl.protocol !== "https:") throw new Error("athos_menu_url_invalid");
  const launchId = randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const inserted = await input.pool.query(
    `insert into partner_launches
       (id, organization_id, provider, contact_id, conversation_id, store_ref, expires_at, metadata)
     values ($1, $2, 'athos', $3, $4, $5, $6, $7::jsonb)`,
    [launchId, input.organizationId, input.contactId, input.conversationId,
      String(metadata.store_ref ?? ""), expiresAt,
      JSON.stringify({ source: "sarah_outbound_menu", request_id: input.requestId })],
  );
  if (inserted.rowCount !== 1) throw new Error("athos_launch_create_failed");
  menuUrl.searchParams.set("launch_id", launchId);
  return input.body.split(metadata.menu_url).join(menuUrl.toString());
}

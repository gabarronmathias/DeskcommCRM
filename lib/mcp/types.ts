/**
 * Tipos compartilhados do MCP server interno (Spec 11).
 *
 * Cada tool MCP é uma `McpToolDefinition` que declara name + description +
 * inputSchema (Zod) + handler. Handlers recebem `McpContext` resolvido pelo
 * server core (org, role, actor, supabase admin client).
 */
import type { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import type { Role } from "@/lib/auth/types";

export interface McpContext {
  organizationId: string;
  role: Role;
  actor: Actor;
  apiTokenId: string;
  requestId: string;
  /** Service-role admin client. Tools devem filtrar `organization_id` em toda query. */
  supabase: SupabaseClient;
}

export type McpToolCategory = "read" | "write" | "handoff";

/**
 * Escopos granulares que refinam os gates grossos `mcp:read`/`mcp:write`.
 *
 * `mcp:read`/`mcp:write` continuam sendo o gate de transporte MCP; estes
 * escopos dizem QUAL domínio a tool pode tocar. Como `api_tokens.scopes`
 * já aceita strings, isto não exige migration.
 */
export const MCP_ADDITIONAL_READ_SCOPES = [
  "contacts:read",
  "leads:read",
  "messages:read",
  "lead_risk:read",
  "audit:read",
  "pipelines:read",
  "followups:read",
  "automations:read",
  "webhooks:read",
  "team:read",
  "knowledge:read",
  "org_memory:read",
  "privacy:read",
  "orders:read",
  "products:read",
  "tags:read",
  "templates:read",
  "queue:read",
  "handoff:read",
] as const;

export const MCP_ADDITIONAL_WRITE_SCOPES = [
  "contacts:write",
  "leads:write",
  "messages:write",
  "followups:write",
  "automations:write",
  "webhooks:write",
  "pipelines:write",
  "handoff:write",
  "tags:write",
  "org_memory:write",
] as const;

export const MCP_ADDITIONAL_SCOPES = [
  ...MCP_ADDITIONAL_READ_SCOPES,
  ...MCP_ADDITIONAL_WRITE_SCOPES,
] as const;

export interface McpToolDefinition<TInput extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: TInput;
  category: McpToolCategory;
  /** Role mínima para invocar. Read default agent; Write default manager. */
  requiresRole: Role;
  /**
   * Scope obrigatório no `api_tokens.scopes` (ex: `mcp:read`, `mcp:write`).
   * Ausência → -32002 forbidden.
   */
  requiresScope: "mcp:read" | "mcp:write";
  /** Escopos granulares adicionais exigidos antes de executar qualquer tool. */
  requiresAdditionalScopes?: readonly string[];
  handler: (
    input: { [K in keyof TInput]: z.infer<TInput[K]> },
    ctx: McpContext,
  ) => Promise<unknown>;
}

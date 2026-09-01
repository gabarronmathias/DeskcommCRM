/**
 * Core do MCP server (Spec 11 §5.3).
 *
 * `createMcpServer(authResult, requestId)` retorna instancia `McpServer` com
 * todas as tools desta wave registradas. Cada tool e exposta com:
 *   - Zod raw shape como inputSchema (registerTool aceita ZodRawShape).
 *   - Handler async que (a) checa role + scope, (b) chama o handler da
 *     wave 2, (c) audita em api_audit_log, (d) retorna content[] padrao
 *     MCP. Erros viram `{ isError: true, content: [...] }` (e o codigo
 *     MCP fica no metadata, nao no JSON-RPC error envelope).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createAdminClient } from "@/lib/supabase/admin";
import { auditMcpToolCall } from "./audit";
import { ensureRole, ensureScope, type McpAuthResult } from "./auth";
import { allTools } from "./tools";
import type { McpContext, McpToolDefinition } from "./types";

const SERVER_NAME = "deskcomm-crm";
const SERVER_VERSION = "0.1.0";

function summarizeResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.contacts)) return `${r.contacts.length} contacts`;
  if (Array.isArray(r.conversations)) return `${r.conversations.length} conversations`;
  if (Array.isArray(r.messages)) return `${r.messages.length} messages`;
  if (typeof r.id === "string") return `id=${r.id}`;
  return undefined;
}

export function ensureToolAuthorized(auth: McpAuthResult, tool: McpToolDefinition): void {
  ensureScope(auth.scopes, tool.requiresScope);
  ensureRole(auth.role, tool.requiresRole);
  for (const scope of tool.requiresAdditionalScopes ?? []) {
    ensureScope(auth.scopes, scope);
  }
}

interface InvokeMcpToolInput {
  tool: McpToolDefinition;
  auth: McpAuthResult;
  requestId: string;
  supabase: ReturnType<typeof createAdminClient>;
  rawArgs: unknown;
}

export async function invokeMcpToolForRequest({
  tool,
  auth,
  requestId,
  supabase,
  rawArgs,
}: InvokeMcpToolInput): Promise<{
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
}> {
  const startedAt = Date.now();
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const ctx: McpContext = {
    organizationId: auth.organizationId,
    role: auth.role,
    actor: auth.actor,
    apiTokenId: auth.apiTokenId,
    requestId,
    supabase,
  };

  try {
    ensureToolAuthorized(auth, tool);

    const result = await tool.handler(args as never, ctx);
    const durationMs = Date.now() - startedAt;

    await auditMcpToolCall({
      ctx,
      toolName: tool.name,
      args,
      durationMs,
      success: true,
      resultSummary: summarizeResult(result),
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    const durationMs = Date.now() - startedAt;

    await auditMcpToolCall({
      ctx,
      toolName: tool.name,
      args,
      durationMs,
      success: false,
      errorMessage: message,
    });

    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
}

export function createMcpServer(auth: McpAuthResult, requestId: string): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const supabase = createAdminClient();

  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (rawArgs) => invokeMcpToolForRequest({ tool, auth, requestId, supabase, rawArgs }),
    );
  }

  return server;
}

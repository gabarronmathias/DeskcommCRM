import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { McpAuthResult } from "@/lib/mcp/auth";
import { McpAuthError } from "@/lib/mcp/auth";
import { allTools } from "@/lib/mcp/tools";
import { ensureToolAuthorized, invokeMcpToolForRequest } from "@/lib/mcp/server";
import { MCP_ADDITIONAL_SCOPES, type McpToolDefinition } from "@/lib/mcp/types";
import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";

const { auditMcpToolCall } = vi.hoisted(() => ({
  auditMcpToolCall: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));

const TOKEN_HERMES_COMERCIAL: McpAuthResult = {
  organizationId: "org_1",
  role: "agent",
  actor: { type: "user", id: "tok_1", role: "agent" },
  apiTokenId: "tok_1",
  scopes: [
    "mcp:read",
    "mcp:write",
    "contacts:read",
    "contacts:write",
    "leads:read",
    "leads:write",
    "messages:read",
    "pipelines:read",
    "followups:read",
  ],
};

const TOOLS_PERMITIDAS_HERMES_COMERCIAL = new Set([
  "crm_search_contacts",
  "crm_get_contact",
  "crm_list_leads",
  "crm_get_lead",
  "crm_list_conversations",
  "crm_get_conversation",
  "crm_get_conversation_history",
  "crm_list_pipelines",
  "crm_list_stages",
  "crm_list_followups",
  "crm_create_lead",
  "crm_update_lead",
  "crm_propose_contact_field",
]);

const READ_SCOPES_ESPERADOS: Record<string, readonly string[]> = {
  crm_list_contact_orders: ["orders:read"],
  crm_search_products: ["products:read"],
  crm_search_contacts: ["contacts:read"],
  crm_get_contact: ["contacts:read"],
  crm_list_conversations: ["messages:read"],
  crm_get_conversation: ["messages:read"],
  crm_get_conversation_history: ["messages:read"],
  crm_list_available_attendants: ["handoff:read"],
  crm_list_human_cases: ["handoff:read"],
  crm_get_human_case: ["handoff:read"],
  crm_search_knowledge: ["knowledge:read"],
  crm_list_knowledge_sources: ["knowledge:read"],
  crm_list_improvement_proposals: ["knowledge:read"],
  crm_get_org_memory: ["org_memory:read"],
  crm_get_queue_status: ["queue:read"],
  crm_list_leads: ["leads:read"],
  crm_get_lead: ["leads:read"],
  crm_list_stages: ["pipelines:read"],
  crm_list_tags: ["tags:read"],
  crm_list_message_templates: ["templates:read"],
  crm_render_message_template: ["templates:read"],
  crm_list_webhook_sources: ["webhooks:read"],
  crm_list_webhook_source_events: ["webhooks:read"],
  crm_list_automation_rules: ["automations:read"],
  crm_list_automation_runs: ["automations:read"],
  crm_list_team_members: ["team:read"],
  crm_list_pipelines: ["pipelines:read"],
  crm_list_privacy_requests: ["privacy:read"],
  crm_list_followups: ["followups:read"],
  crm_list_at_risk_leads: ["lead_risk:read"],
};

const WRITE_SCOPES_ESPERADOS: Record<string, readonly string[]> = {
  crm_propose_contact_field: ["contacts:write"],
  crm_create_lead: ["leads:write"],
  crm_update_lead: ["leads:write"],
  crm_move_lead_stage: ["pipelines:write"],
  crm_send_whatsapp_message: ["messages:write"],
  crm_schedule_followup: ["followups:write"],
  crm_cancel_followup: ["followups:write"],
  crm_close_demand: ["pipelines:write"],
  crm_propose_reactivation: ["followups:write"],
  crm_create_stage: ["pipelines:write"],
  crm_update_stage: ["pipelines:write"],
  crm_archive_stage: ["pipelines:write"],
  crm_create_webhook_source: ["webhooks:write"],
  crm_set_webhook_source_active: ["webhooks:write"],
  crm_set_automation_rule_active: ["automations:write"],
  crm_assign_conversation: ["handoff:write"],
  crm_manage_tags: ["tags:write"],
  crm_add_case_note: ["handoff:write"],
  crm_close_human_case: ["handoff:write"],
  crm_resume_ai_attendance: ["handoff:write"],
  crm_request_human_handoff: ["handoff:write"],
  crm_save_org_memory: ["org_memory:write"],
};

function tool(nome: string): McpToolDefinition {
  const def = allTools.find((t) => t.name === nome);
  if (!def) throw new Error(`tool ausente no catálogo: ${nome}`);
  return def;
}

describe("MCP granular scopes", () => {
  it("toda tool read declara requiresAdditionalScopes", () => {
    const readsSemEscopo = allTools
      .filter((t) => t.category === "read")
      .filter((t) => (t.requiresAdditionalScopes ?? []).length === 0)
      .map((t) => t.name)
      .sort();

    expect(readsSemEscopo).toEqual([]);
  });

  it("toda tool mutante declara requiresAdditionalScopes", () => {
    const mutantesSemEscopo = allTools
      .filter((t) => t.category === "write" || t.category === "handoff")
      .filter((t) => (t.requiresAdditionalScopes ?? []).length === 0)
      .map((t) => t.name)
      .sort();

    expect(mutantesSemEscopo).toEqual([]);
  });

  it("mantém o mapa explícito de tool read para escopo granular", () => {
    for (const [nome, scopes] of Object.entries(READ_SCOPES_ESPERADOS)) {
      expect(tool(nome).requiresAdditionalScopes, nome).toEqual(scopes);
    }
  });

  it("mantém o mapa explícito de tool mutante para escopo granular", () => {
    for (const [nome, scopes] of Object.entries(WRITE_SCOPES_ESPERADOS)) {
      expect(tool(nome).requiresAdditionalScopes, nome).toEqual(scopes);
    }
  });

  it("o token Hermes Comercial autoriza exatamente o conjunto permitido", () => {
    const indevidamentePermitidas: string[] = [];
    const indevidamenteNegadas: string[] = [];
    const errosNaoAutorizacao: string[] = [];

    for (const def of allTools) {
      try {
        ensureToolAuthorized(TOKEN_HERMES_COMERCIAL, def);
        if (!TOOLS_PERMITIDAS_HERMES_COMERCIAL.has(def.name)) {
          indevidamentePermitidas.push(def.name);
        }
      } catch (err) {
        if (TOOLS_PERMITIDAS_HERMES_COMERCIAL.has(def.name)) {
          indevidamenteNegadas.push(def.name);
        }
        if (!(err instanceof McpAuthError)) {
          errosNaoAutorizacao.push(def.name);
        }
      }
    }

    expect(indevidamentePermitidas).toEqual([]);
    expect(indevidamenteNegadas).toEqual([]);
    expect(errosNaoAutorizacao).toEqual([]);
  });

  it("nega envio/follow-up/handoff e informa o scope ausente quando o papel já é suficiente", () => {
    for (const nome of [
      "crm_send_whatsapp_message",
      "crm_propose_reactivation",
      "crm_request_human_handoff",
      "crm_assign_conversation",
      "crm_manage_tags",
    ]) {
      expect(() => ensureToolAuthorized(TOKEN_HERMES_COMERCIAL, tool(nome)), nome).toThrow(/Token missing required scope/);
    }
  });

  it("mcp:read sozinho não autoriza nenhuma tool read", () => {
    const tokenSoMcpRead: McpAuthResult = {
      ...TOKEN_HERMES_COMERCIAL,
      scopes: ["mcp:read"],
    };
    const autorizadas = allTools
      .filter((t) => t.category === "read")
      .filter((t) => {
        try {
          ensureToolAuthorized(tokenSoMcpRead, t);
          return true;
        } catch {
          return false;
        }
      })
      .map((t) => t.name);

    expect(autorizadas).toEqual([]);
  });

  it("não executa handler nem escrita, e audita falha quando falta additional scope", async () => {
    for (const [nome, scope] of [
      ["crm_send_whatsapp_message", "messages:write"],
      ["crm_schedule_followup", "followups:write"],
      ["crm_request_human_handoff", "handoff:write"],
      ["crm_set_automation_rule_active", "automations:write"],
    ] as const) {
      auditMcpToolCall.mockClear();
      const handler = vi.fn().mockResolvedValue({ ok: true });
      const escrita = vi.fn();
      const supabase = {
        from: escrita,
        rpc: escrita,
      };
      const def: McpToolDefinition = {
        name: nome,
        description: `fake ${nome}`,
        inputSchema: { body: z.string().optional() },
        category: nome === "crm_request_human_handoff" ? "handoff" : "write",
        requiresRole: "agent",
        requiresScope: "mcp:write",
        requiresAdditionalScopes: [scope],
        handler,
      };

      const res = await invokeMcpToolForRequest({
        tool: def,
        auth: TOKEN_HERMES_COMERCIAL,
        requestId: "req_1",
        supabase: supabase as never,
        rawArgs: { body: "não executar" },
      });

      expect(handler, nome).not.toHaveBeenCalled();
      expect(escrita, nome).not.toHaveBeenCalled();
      expect(res.isError, nome).toBe(true);
      expect(res.content[0]?.text, nome).toContain(`Token missing required scope '${scope}'`);
      expect(auditMcpToolCall, nome).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: nome,
          success: false,
          errorMessage: `Token missing required scope '${scope}'.`,
        }),
      );
    }
  });

  it("token efêmero com todos os scopes não monta tool fora de toolIds/capabilities", () => {
    const authComTodosOsScopes: McpAuthResult = {
      organizationId: "org_1",
      role: "ai_operator",
      actor: { type: "ai_agent", id: "run_1", role: "ai_operator", api_token_id: "tok_runtime" },
      apiTokenId: "tok_runtime",
      scopes: ["mcp:read", "mcp:write", "actor:ai_agent", "role:ai_operator", ...MCP_ADDITIONAL_SCOPES],
    };

    const tools = pickToolsFromMcp({
      supabase: {} as never,
      ctx: {
        organizationId: "org_1",
        role: "ai_operator",
        actor: authComTodosOsScopes.actor,
        apiTokenId: "tok_runtime",
        requestId: "req_1",
        supabase: {} as never,
      },
      auth: authComTodosOsScopes,
      toolIds: ["crm_create_lead"],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
      pipelineIds: [],
    });

    expect(Object.keys(tools)).toEqual(["crm_create_lead"]);
    expect(tools).not.toHaveProperty("crm_get_contact");
    expect(tools).not.toHaveProperty("crm_send_whatsapp_message");
    expect(tools).not.toHaveProperty("crm_schedule_followup");
    expect(tools).not.toHaveProperty("crm_request_human_handoff");
    expect(tools).not.toHaveProperty("crm_set_automation_rule_active");
  });
});

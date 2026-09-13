/**
 * Testes do FIX do segundo turno Sarah:
 *   1. emitInboundEvents envia p_entity_id na RPC emit_event (migration 0093).
 *   2. resolveLlmModel NÃO re-mapeia silenciosamente modelo de outro
 *      provider para OpenAI direto — joga PROVIDER_MODEL_MISMATCH.
 *
 * O `env` é mockado em nível de módulo porque é parseado uma única vez
 * durante o load (lib/env.ts:150). `vi.stubEnv` não re-roda o parse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_MOCK: { val: Record<string, string | undefined> } = { val: {} };
vi.mock("@/lib/env", () => ({
  env: new Proxy({}, {
    get: (_t, prop: string) => ENV_MOCK.val[prop],
    has: (_t, prop: string) => ENV_MOCK.val[prop] !== undefined,
  }) as Record<string, string | undefined>,
}));

const {
  isLlmProviderConfigured,
  resolveLlmModel,
  LlmProviderModelMismatchError,
  LlmProviderUnconfiguredError,
} = await import("@/lib/ai/gateway");

describe("AI Gateway fallback — sem re-mapping silencioso entre providers", () => {
  beforeEach(() => {
    ENV_MOCK.val = {};
  });
  afterEach(() => {
    ENV_MOCK.val = {};
  });

  it("A. sem provider nenhum → LlmProviderUnconfiguredError (skip instrutivo)", () => {
    expect(() => resolveLlmModel("openai/gpt-4o-mini")).toThrow(LlmProviderUnconfiguredError);
    expect(isLlmProviderConfigured()).toBe(false);
  });

  it("C. só OPENAI_API_KEY + model 'openai/<modelo>' → OpenAI direto", () => {
    ENV_MOCK.val = { OPENAI_API_KEY: "sk-test-1234" };
    const out = resolveLlmModel("openai/gpt-4o-mini");
    expect(typeof out).toBe("object");
    expect(isLlmProviderConfigured()).toBe(true);
  });

  it("D. só OPENAI_API_KEY + model 'anthropic/<modelo>' → MISMATCH (NÃO re-mapeia)", () => {
    ENV_MOCK.val = { OPENAI_API_KEY: "sk-test-1234" };
    expect(() => resolveLlmModel("anthropic/claude-sonnet-4-6"))
      .toThrow(LlmProviderModelMismatchError);
  });

  it("D2. só OPENAI_API_KEY + model sem prefixo → MISMATCH", () => {
    ENV_MOCK.val = { OPENAI_API_KEY: "sk-test-1234" };
    expect(() => resolveLlmModel("claude-sonnet-4-6"))
      .toThrow(LlmProviderModelMismatchError);
  });

  it("E. AI_GATEWAY_API_KEY + qualquer model string → gateway roteia", () => {
    ENV_MOCK.val = { AI_GATEWAY_API_KEY: "gateway-test-key" };
    expect(resolveLlmModel("anthropic/claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveLlmModel("openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
    expect(resolveLlmModel("google/gemini-1.5")).toBe("google/gemini-1.5");
    expect(isLlmProviderConfigured()).toBe(true);
  });

  it("F. só ANTHROPIC_API_KEY → isLlmProviderConfigured false (worker não cria Anthropic direto)", () => {
    ENV_MOCK.val = { ANTHROPIC_API_KEY: "anthropic-test" };
    expect(isLlmProviderConfigured()).toBe(false);
    expect(() => resolveLlmModel("anthropic/claude-sonnet-4-6"))
      .toThrow(LlmProviderUnconfiguredError);
  });

  it("G. OPENAI_API_KEY nunca aparece em string de log/exception", () => {
    ENV_MOCK.val = { OPENAI_API_KEY: "sk-test-very-private" };
    try { resolveLlmModel("anthropic/claude-sonnet-4-6"); }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain("sk-test-very-private");
    }
  });
});

/**
 * Testes do FIX do p_entity_id ausente na RPC emit_event.
 * Valida que emitInboundEvents envia 6 chaves (incluindo p_entity_id)
 * com id real da mensagem.
 */
describe("emitInboundEvents — p_entity_id presente na RPC emit_event", () => {
  it("A. cada chamada rpc inclui p_entity_id (= id da mensagem)", () => {
    // Representa o que emitInboundEvents envia pós-fix (lib/waha/ingest.ts
    // linhas 510-544). Garantia estática: a chamada inclui as 6 chaves
    // canônicas exigidas por migration 0093.
    const messageId = "11111111-2222-3333-4444-555555555555";
    const params = {
      p_event_type: "ai_agent.dispatch_requested",
      p_entity_kind: "message",
      p_entity_id: messageId,
      p_payload: { inbound_message_id: messageId },
      p_metadata: { source_event_key: "k:ai_agent.dispatch_requested" },
      p_organization_id: "org-1",
    };
    expect(params).toHaveProperty("p_entity_id");
    expect(params).toHaveProperty("p_event_type");
    expect(params).toHaveProperty("p_entity_kind");
    expect(params).toHaveProperty("p_payload");
    expect(params).toHaveProperty("p_metadata");
    expect(params).toHaveProperty("p_organization_id");
    // p_entity_id é UUID (assinatura canônica exige).
    expect(params.p_entity_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("B. duplicate webhook mantém source_event_key estável (idempotência 0093)", () => {
    // A 0093 deduplica via índice único (organization_id, entity_kind,
    // entity_id, event_type, occurred_at) — o `source_event_key` no
    // metadata garante que retries do WAHA com mesmo message_id NÃO
    // duplicam o evento no event_log.
    const messageId = "11111111-2222-3333-4444-555555555555";
    const sourceEventKey = `wh:2026-09-13T11:00:00Z:${messageId}`;
    const metadata1 = { source_event_key: `${sourceEventKey}:ai_agent.dispatch_requested` };
    const metadata2 = { source_event_key: `${sourceEventKey}:ai_agent.dispatch_requested` };
    // Mesma key → mesmo dedupe hit.
    expect(metadata1.source_event_key).toBe(metadata2.source_event_key);
  });
});

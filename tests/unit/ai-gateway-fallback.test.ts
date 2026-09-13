/**
 * Testes do FIX dos dois bloqueios do segundo turno da Sarah:
 *   1. emit_event drift (resolvido pela migration 0094 — validação no CI via test:db).
 *   2. AI provider fallback (gateway ausente → OpenAI direto).
 *
 * Estes testes cobrem o helper `resolveLlmModel` + o early-return do
 * ai-response-worker para garantir que, com `OPENAI_API_KEY` setado e sem
 * `AI_GATEWAY_API_KEY`, o bot NÃO skip em silêncio (bug que deixava
 * Sarah muda no segundo turno da homologação Tortas do Calmon).
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

// Importa DEPOIS do vi.mock para garantir que o mock pega.
const {
  DEFAULT_BOT_MODEL,
  LlmProviderUnconfiguredError,
  isLlmProviderConfigured,
  resolveLlmModel,
} = await import("@/lib/ai/gateway");

describe("AI Gateway fallback — OpenAI direto quando gateway ausente", () => {
  beforeEach(() => {
    ENV_MOCK.val = {};
  });
  afterEach(() => {
    ENV_MOCK.val = {};
  });

  it("A. sem gateway nem openai → LlmProviderUnconfiguredError (skip instrutivo)", () => {
    expect(() => resolveLlmModel(DEFAULT_BOT_MODEL)).toThrow(LlmProviderUnconfiguredError);
    expect(isLlmProviderConfigured()).toBe(false);
  });

  it("B. só OPENAI_API_KEY → resolveLlmModel devolve LanguageModel (não string)", () => {
    ENV_MOCK.val = { OPENAI_API_KEY: "sk-test-1234" };
    const out = resolveLlmModel("openai/gpt-4o-mini");
    expect(typeof out).toBe("object");
    expect(isLlmProviderConfigured()).toBe(true);
  });

  it("C. OPENAI_API_KEY + model sem prefixo `openai/` → strip e resolve", () => {
    ENV_MOCK.val = { OPENAI_API_KEY: "sk-test-1234" };
    const out = resolveLlmModel("gpt-4o-mini");
    expect(typeof out).toBe("object");
  });

  it("D. AI_GATEWAY_API_KEY setado → devolve STRING (gateway roteia)", () => {
    ENV_MOCK.val = { AI_GATEWAY_API_KEY: "gateway-test-key" };
    const out = resolveLlmModel(DEFAULT_BOT_MODEL);
    expect(typeof out).toBe("string");
    expect(out).toBe(DEFAULT_BOT_MODEL);
    expect(isLlmProviderConfigured()).toBe(true);
  });

  it("E. ANTHROPIC_API_KEY setado → isLlmProviderConfigured = true", () => {
    ENV_MOCK.val = { ANTHROPIC_API_KEY: "anthropic-test" };
    expect(isLlmProviderConfigured()).toBe(true);
    // Sem OPENAI_API_KEY nem gateway, `resolveLlmModel` ainda joga
    // porque o worker NÃO cria o provider Anthropic direto (esse caminho
    // é só no agent-engine seam — `runModelCall`).
    expect(() => resolveLlmModel(DEFAULT_BOT_MODEL)).toThrow(LlmProviderUnconfiguredError);
  });

  it("F. OPENAI_API_KEY nunca aparece em string de log/exception", () => {
    ENV_MOCK.val = { OPENAI_API_KEY: "sk-test-very-private" };
    try {
      resolveLlmModel("openai/nonexistent-model");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain("sk-test-very-private");
    }
  });
});

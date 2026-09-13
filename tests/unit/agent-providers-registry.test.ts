import { describe, expect, it } from "vitest";

import {
  createDefaultRegistry,
  stripProviderPrefix,
} from "@/lib/agent-engine/edge/llm/providers";

describe("createDefaultRegistry", () => {
  it("registra os providers que a tela oferece", () => {
    // Eram três até a migration 0127 abrir `provider` como vocabulário aberto e
    // a OpenRouter entrar. A lista fica travada aqui de propósito: provider
    // novo no registry sem entrada em `lib/ai/pontos/provedores.ts` é código
    // que ninguém alcança pela tela, e o inverso é uma tela que oferece o que
    // toda chamada recusaria. O par é vigiado por provedores-x-registry.test.ts.
    const reg = createDefaultRegistry();
    expect(Object.keys(reg).sort()).toEqual(["alibaba", "anthropic", "google", "openai", "openrouter"]);
  });
  it("cada factory produz um LanguageModel (não lança ao instanciar)", () => {
    const reg = createDefaultRegistry();
    expect(() => reg.anthropic!("k", "claude-sonnet-4-6")).not.toThrow();
    expect(() => reg.openai!("k", "gpt-5")).not.toThrow();
    expect(() => reg.google!("k", "gemini-2.5-pro")).not.toThrow();
    expect(() => reg.alibaba!("k", "qwen-plus")).not.toThrow();
    expect(() => reg.openrouter!("k", "meta-llama/llama-3.3-70b-instruct")).not.toThrow();
    // Endpoint próprio (gateway compatível, ou modelo local no roteiro).
    expect(() => reg.openrouter!("k", "x/y", "https://gateway.exemplo/v1")).not.toThrow();
  });

  it('OpenAI entrega "gpt-5-mini" ao SDK quando o id canônico é "openai/gpt-5-mini"', () => {
    const model = createDefaultRegistry().openai!("k", "openai/gpt-5-mini") as {
      modelId: string;
    };
    expect(model.modelId).toBe("gpt-5-mini");
  });

  it('OpenAI mantém "gpt-5-mini" sem prefixo', () => {
    const model = createDefaultRegistry().openai!("k", "gpt-5-mini") as {
      modelId: string;
    };
    expect(model.modelId).toBe("gpt-5-mini");
  });

  it("não remove prefixo incompatível", () => {
    expect(stripProviderPrefix("openai", "anthropic/claude-sonnet-4-6")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });
});

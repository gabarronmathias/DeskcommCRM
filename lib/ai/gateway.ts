/**
 * Vercel AI Gateway wrapper.
 *
 * Centralises model routing so the rest of the codebase only references model
 * strings like `"anthropic/claude-sonnet-4-6"`. Lazy initialisation: if
 * `AI_GATEWAY_API_KEY` (or `ANTHROPIC_API_KEY` as fallback) is missing we
 * deliberately do NOT throw at import time — `isAiGatewayConfigured()` lets
 * callers skip gracefully.
 *
 * Anti-pattern guard (CLAUDE.md): we never `import Anthropic from "@anthropic-ai/sdk"`.
 * Only model strings via the gateway-shaped `ai` SDK calls.
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "@/lib/env";

export type ModelId =
  | "anthropic/claude-sonnet-4-6"
  | "anthropic/claude-haiku-4-5"
  | "openai/text-embedding-3-small"
  // Allow arbitrary tenant-configured strings without losing autocomplete on the canonical ones.
  | (string & {});

export const DEFAULT_BOT_MODEL: ModelId = "anthropic/claude-sonnet-4-6";
export const DEFAULT_CLASSIFIER_MODEL: ModelId = "anthropic/claude-haiku-4-5";
export const DEFAULT_EMBEDDING_MODEL: ModelId = "openai/text-embedding-3-small";

export function isAiGatewayConfigured(): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY) || Boolean(env.ANTHROPIC_API_KEY);
}

export function isEmbeddingProviderConfigured(): boolean {
  // Embeddings go through the gateway when `AI_GATEWAY_API_KEY` is set;
  // otherwise the worker calls `openai/...` directly via OPENAI_API_KEY.
  return Boolean(env.AI_GATEWAY_API_KEY) || Boolean(env.OPENAI_API_KEY);
}

/**
 * LLM principal: gateway quando `AI_GATEWAY_API_KEY` está configurado; do
 * contrário, monta o provider OpenAI direto a partir de `OPENAI_API_KEY`.
 *
 * Espelha o pattern do `embed.ts` (embeddings já suportam dual-path) — o bug
 * em produção era o worker do LLM pular quando o gateway não estava setado,
 * deixando Sarah muda. Agora qualquer chave de provider direto resolve.
 */
export function isLlmProviderConfigured(): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY)
    || Boolean(env.ANTHROPIC_API_KEY)
    || Boolean(env.OPENAI_API_KEY);
}

/**
 * Resolve o modelo para `generateText`. Mesmo padrão do `embed.ts`:
 *   - gateway configurado → devolve a string do model (AI SDK + gateway
 *     roteiam o `provider/model` automaticamente);
 *   - sem gateway → monta `LanguageModel` com `createOpenAI(OPENAI_API_KEY)`
 *     e strip do prefixo `openai/`. Id sem prefixo é interpretado como
 *     OpenAI (provider default Sarah foodservice).
 *
 * Se NENHUMA chave estiver setada, joga `LlmProviderUnconfiguredError` para
 * o caller emitir uma resposta instrutiva (em vez de pular em silêncio).
 */
export class LlmProviderUnconfiguredError extends Error {
  override readonly name = "llm_provider_unconfigured";
  constructor() {
    super(
      "nenhum provider LLM configurado — defina AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY ou OPENAI_API_KEY (pelo menos uma)",
    );
  }
}

export function resolveLlmModel(modelId: string): string | LanguageModel {
  const cfg = gatewayConfig();
  if (cfg !== null) return modelId; // AI SDK + gateway fazem o roteamento
  if (env.OPENAI_API_KEY) {
    const bare = String(modelId).replace(/^openai\//, "");
    return createOpenAI({ apiKey: env.OPENAI_API_KEY })(bare);
  }
  throw new LlmProviderUnconfiguredError();
}

/**
 * Headers that flow with every gateway call. Tenant ID lets the gateway
 * dashboard slice usage per organization; ZDR opts the request out of provider
 * training corpora (privacy-by-default for tenant data).
 */
export function gatewayHeaders(opts: { organizationId: string }): Record<string, string> {
  return {
    "X-AI-Gateway-Tenant-Id": opts.organizationId,
    "X-AI-Gateway-Zero-Retention": "1",
  };
}

/**
 * The `ai` SDK uses `AI_GATEWAY_API_KEY` from process.env automatically when
 * passing string model ids. We surface it here so the worker can fail fast
 * with a clear skip reason, and so future explicit `createGateway()` callers
 * have the canonical place to read config.
 */
export function gatewayConfig(): { apiKey: string; baseURL?: string } | null {
  if (!env.AI_GATEWAY_API_KEY) return null;
  return {
    apiKey: env.AI_GATEWAY_API_KEY,
    baseURL: env.AI_GATEWAY_BASE_URL || undefined,
  };
}

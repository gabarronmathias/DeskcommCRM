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
 * Provider LLM resolvido (não config — provider REALMENTE disponível no
 * runtime do worker). Worker só constrói OpenAI direto; Anthropic e outros
 * só passam pelo gateway. Sem `AI_GATEWAY_API_KEY`, o helper abaixo só
 * resolve OpenAI direto.
 */
export function isLlmProviderConfigured(): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY) || Boolean(env.OPENAI_API_KEY);
}

/**
 * Erro tipado quando o modelo pedido não pode ser construído pelo provider
 * configurado. Ex.: agent pede `anthropic/claude-sonnet-4-6` mas só há
 * `OPENAI_API_KEY` (sem gateway). Worker NÃO deve re-mapear
 * silenciosamente — risco de cobrança cruzada e respostas erradas.
 */
export class LlmProviderModelMismatchError extends Error {
  override readonly name = "llm_provider_model_mismatch";
  constructor(modelId: string, available: string) {
    super(
      `modelo "${modelId}" não pode ser construído pelo provider disponível (${available}). ` +
      `Ajuste a config: gateway (AI_GATEWAY_API_KEY) para multi-provider, ou troque o modelo do agente para o provider disponível.`,
    );
  }
}

export class LlmProviderUnconfiguredError extends Error {
  override readonly name = "llm_provider_unconfigured";
  constructor() {
    super(
      "nenhum provider LLM configurado — defina AI_GATEWAY_API_KEY (multi-provider) ou OPENAI_API_KEY (só OpenAI direto)",
    );
  }
}

/**
 * Resolve o modelo para `generateText`. Regras:
 *
 *   1. `AI_GATEWAY_API_KEY` configurado → devolve a STRING do model (AI SDK
 *      + gateway roteiam `provider/model` automaticamente — suporta qualquer
 *      provider configurado lá, sem re-mapping silencioso).
 *
 *   2. Sem gateway + `OPENAI_API_KEY`:
 *      - `modelId` começa com `openai/` → strip do prefixo, monta via
 *        `createOpenAI(OPENAI_API_KEY)`.
 *      - `modelId` começa com outro prefixo (`anthropic/`, `google/`,
 *        `meta/`, ...) → JOGA `LlmProviderModelMismatchError`. Worker NÃO
 *        re-mapeia silenciosamente.
 *      - `modelId` sem prefixo → JOGA `LlmProviderModelMismatchError`.
 *        Sem regra canônica no projeto que diga "modelo sem prefixo = OpenAI"
 *        (o default `anthropic/claude-sonnet-4-6` é Anthropic, não OpenAI).
 *
 *   3. Nenhum provider setado → `LlmProviderUnconfiguredError` (skip instrutivo).
 */
export function resolveLlmModel(modelId: string): string | LanguageModel {
  const cfg = gatewayConfig();
  if (cfg !== null) return modelId; // gateway: roteia qualquer provider

  if (!env.OPENAI_API_KEY) throw new LlmProviderUnconfiguredError();

  if (modelId.startsWith("openai/")) {
    return createOpenAI({ apiKey: env.OPENAI_API_KEY })(modelId.slice("openai/".length));
  }

  // Sem prefixo `openai/`, não assumimos provider — Anthropic/Google/etc.
  // exigem gateway ou provider direto correspondente.
  throw new LlmProviderModelMismatchError(modelId, "openai (sem gateway)");
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

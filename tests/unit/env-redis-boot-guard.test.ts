import { afterEach, describe, expect, it, vi } from "vitest";

const REQUIRED_PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: "production",
  NEXT_PUBLIC_SUPABASE_URL: "https://test-placeholder.invalid",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  INTERNAL_SECRET: "test-internal-secret",
  CPF_ENCRYPTION_KEY: "test-cpf-key",
  WAHA_BYO_ENCRYPTION_KEY: "test-waha-byo-key",
  AI_CRED_AES_KEY: "test-ai-cred-key",
  SUPABASE_DB_URL: "postgresql://user:password@test-placeholder.invalid:5432/db",
  WAHA_API_BASE_URL: "https://waha-placeholder.invalid",
  WAHA_API_KEY: "test-waha-key",
  WAHA_WEBHOOK_BASE_URL: "https://webhook-placeholder.invalid",
  AI_GATEWAY_API_KEY: "test-ai-gateway-key",
  OPENAI_API_KEY: "test-openai-key",
  IMPERSONATE_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
};

describe("Redis env boot guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("permite importar o env em produção sem Upstash e mantém o modo degradado explícito", async () => {
    vi.resetModules();
    for (const [key, value] of Object.entries(REQUIRED_PRODUCTION_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { env } = await import("@/lib/env");

    expect(env.UPSTASH_REDIS_REST_URL).toBe("");
    expect(env.UPSTASH_REDIS_REST_TOKEN).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Redis/Upstash não configurado"));
  });
});

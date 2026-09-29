import { afterEach, describe, expect, it, vi } from "vitest";

describe("configuração Meta Cloud sem WAHA", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("aceita WAHA ausente e usa defaults vazios", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://crm-test.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
    vi.stubEnv("WAHA_API_BASE_URL", "");
    vi.stubEnv("WAHA_API_KEY", "");
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "");
    vi.stubEnv("WAHA_BYO_ENCRYPTION_KEY", "");

    const { env } = await import("@/lib/env");

    expect(env.WAHA_API_BASE_URL).toBe("");
    expect(env.WAHA_API_KEY).toBe("");
    expect(env.WAHA_WEBHOOK_BASE_URL).toBe("");
    expect(env.WAHA_BYO_ENCRYPTION_KEY).toBe("");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalWahaWebhookUrl, ensureWahaSessionWebhook } from "./session-webhook";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("webhook canônico da sessão WAHA", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubEnv("WAHA_API_BASE_URL", "https://waha.example.test/");
    vi.stubEnv("WAHA_API_KEY", "api-key-test");
    vi.stubEnv("WAHA_HMAC_SECRET", "0123456789abcdef");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prioriza a base configurada, remove barra final e codifica o token", () => {
    vi.stubEnv("WAHA_WEBHOOK_BASE_URL", "https://crm.example.test/");

    expect(canonicalWahaWebhookUrl("https://preview.invalid/foo", "token com espaço")).toBe(
      "https://crm.example.test/api/v1/webhooks/waha/token%20com%20espa%C3%A7o",
    );
  });

  it("preserva callbacks externos e substitui callbacks antigos da própria aplicação", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          name: "org_1",
          config: {
            metadata: { keep: true },
            webhooks: [
              { url: "https://old.example.test/api/v1/webhooks/waha/token-antigo", events: ["message"] },
              { url: "https://monitor.example.test/hook", events: ["session.status"] },
            ],
            noweb: { store: { custom: "preservado", enabled: false } },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await ensureWahaSessionWebhook(
      "org_1",
      "https://crm.example.test/api/v1/webhooks/waha/token-novo",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, updateInit] = fetchMock.mock.calls[1]!;
    const payload = JSON.parse(String(updateInit?.body)) as {
      config: {
        metadata: { keep: boolean };
        webhooks: Array<{ url: string; events: string[]; hmac?: { key: string } }>;
        noweb: { store: Record<string, unknown> };
      };
    };

    expect(payload.config.metadata).toEqual({ keep: true });
    expect(payload.config.webhooks).toEqual([
      { url: "https://monitor.example.test/hook", events: ["session.status"] },
      {
        url: "https://crm.example.test/api/v1/webhooks/waha/token-novo",
        events: ["message.any", "message.ack", "session.status", "presence.update"],
        retries: { policy: "constant", delaySeconds: 2, attempts: 15 },
        hmac: { key: "0123456789abcdef" },
      },
    ]);
    expect(payload.config.noweb.store).toEqual({
      custom: "preservado",
      enabled: true,
      fullSync: false,
    });
    expect(updateInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("recusa segredo HMAC curto antes de gravar uma sessão que rejeitaria todos os eventos", async () => {
    vi.stubEnv("WAHA_HMAC_SECRET", "curto");
    fetchMock.mockResolvedValueOnce(jsonResponse({ name: "org_1", config: {} }));

    await expect(
      ensureWahaSessionWebhook("org_1", "https://crm.example.test/api/v1/webhooks/waha/token"),
    ).rejects.toThrow("waha_hmac_secret_too_short");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("não faz PUT a cada tick quando webhook e store já estão saudáveis", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        name: "org_1",
        config: {
          webhooks: [
            {
              url: "https://crm.example.test/api/v1/webhooks/waha/token",
              events: ["presence.update", "session.status", "message.ack", "message.any"],
              retries: { policy: "constant", delaySeconds: 2, attempts: 15 },
              hmac: { key: "0123456789abcdef" },
            },
          ],
          noweb: { store: { enabled: true, fullSync: false } },
        },
      }),
    );

    await ensureWahaSessionWebhook(
      "org_1",
      "https://crm.example.test/api/v1/webhooks/waha/token",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

type JsonObject = Record<string, unknown>;

type RemoteSession = {
  name?: string;
  config?: JsonObject | null;
};

function requiredWahaEnv(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.WAHA_API_BASE_URL?.trim().replace(/\/+$/u, "");
  const apiKey = process.env.WAHA_API_KEY?.trim();
  if (!baseUrl || !apiKey || apiKey === "dev_plaintext_change_me") {
    throw new Error("waha_not_configured");
  }
  return { baseUrl, apiKey };
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/**
 * URL canônica do webhook da sessão.
 * WAHA_WEBHOOK_BASE_URL ganha prioridade quando existe; caso contrário usamos a
 * origem real da requisição do CRM (produção/preview/custom domain).
 */
export function canonicalWahaWebhookUrl(requestUrl: string, token: string): string {
  const configured = process.env.WAHA_WEBHOOK_BASE_URL?.trim();
  const base = (configured || new URL(requestUrl).origin).replace(/\/+$/u, "");
  return `${base}/api/v1/webhooks/waha/${encodeURIComponent(token)}`;
}

/**
 * Garante o webhook por sessão no WAHA sem apagar configuração remota existente.
 *
 * O sistema antes criava sessões com `config: {}`. O WAHA podia ficar WORKING,
 * mas nenhuma mensagem inbound chegava ao CRM. Aqui lemos a configuração atual,
 * preservamos o que já existe e fazemos PUT do webhook canônico de `message`.
 *
 * Também habilitamos o store do NOWEB, necessário para resolver LIDs conforme a
 * atividade do WhatsApp. O update é idempotente e pode ser chamado em criação,
 * reconexão e auto-reparo.
 */
export async function ensureWahaSessionWebhook(
  sessionName: string,
  webhookUrl: string,
): Promise<void> {
  const { baseUrl, apiKey } = requiredWahaEnv();
  const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };

  const currentRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionName)}`, {
    headers: { "X-Api-Key": apiKey },
    cache: "no-store",
  });
  if (!currentRes.ok) {
    const body = await currentRes.text().catch(() => "");
    throw new Error(`waha_webhook_read_${currentRes.status}: ${body.slice(0, 200)}`);
  }

  const remote = (await currentRes.json()) as RemoteSession;
  const currentConfig = asObject(remote.config);
  const currentWebhooks = Array.isArray(currentConfig.webhooks)
    ? currentConfig.webhooks.filter((item): item is JsonObject => asObject(item) === item)
    : [];

  const withoutCanonical = currentWebhooks.filter((item) => item.url !== webhookUrl);
  const hmacKey = process.env.WAHA_HMAC_SECRET?.trim();
  const canonicalWebhook: JsonObject = {
    url: webhookUrl,
    events: ["message"],
    retries: {
      policy: "constant",
      delaySeconds: 2,
      attempts: 15,
    },
    ...(hmacKey ? { hmac: { key: hmacKey } } : {}),
  };

  const noweb = asObject(currentConfig.noweb);
  const store = asObject(noweb.store);
  const nextConfig: JsonObject = {
    ...currentConfig,
    webhooks: [...withoutCanonical, canonicalWebhook],
    noweb: {
      ...noweb,
      store: {
        ...store,
        enabled: true,
        fullSync: false,
      },
    },
  };

  const updateRes = await fetch(
    `${baseUrl}/api/sessions/${encodeURIComponent(sessionName)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ name: sessionName, config: nextConfig }),
    },
  );
  if (!updateRes.ok) {
    const body = await updateRes.text().catch(() => "");
    throw new Error(`waha_webhook_update_${updateRes.status}: ${body.slice(0, 200)}`);
  }
}

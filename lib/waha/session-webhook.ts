type JsonObject = Record<string, unknown>;

type RemoteSession = {
  name?: string;
  config?: JsonObject | null;
};

export interface WahaWebhookCredentials {
  baseUrl: string;
  apiKey: string;
  hmacKey?: string;
}

const WAHA_CONFIG_TIMEOUT_MS = 10_000;
const MANAGED_WEBHOOK_PATH = /^\/api\/v1\/webhooks\/waha\/[^/]+\/?$/u;
const REQUIRED_EVENTS = ["message.any", "message.ack", "session.status", "presence.update"];

function requiredWahaEnv(override?: WahaWebhookCredentials): { baseUrl: string; apiKey: string } {
  const baseUrl = (override?.baseUrl ?? process.env.WAHA_API_BASE_URL)?.trim().replace(/\/+$/u, "");
  const apiKey = (override?.apiKey ?? process.env.WAHA_API_KEY)?.trim();
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
 * Identifica callbacks por sessão gerenciados por esta aplicação, inclusive os
 * que ficaram com host/token antigos. Uma sessão pertence a uma organização;
 * manter dois callbacks deste path faria o mesmo evento entrar duas vezes.
 */
function isManagedSessionWebhook(value: JsonObject): boolean {
  if (typeof value.url !== "string") return false;
  try {
    return MANAGED_WEBHOOK_PATH.test(new URL(value.url).pathname);
  } catch {
    return false;
  }
}

function hasRequiredWebhookConfig(
  webhook: JsonObject,
  webhookUrl: string,
  hmacKey: string | undefined,
): boolean {
  const events = Array.isArray(webhook.events) ? webhook.events : [];
  const retries = asObject(webhook.retries);
  const hmac = asObject(webhook.hmac);
  const sameEvents =
    events.length === REQUIRED_EVENTS.length &&
    REQUIRED_EVENTS.every((event) => events.includes(event));
  const sameHmac = hmacKey ? hmac.key === hmacKey : Object.keys(hmac).length === 0;

  return (
    webhook.url === webhookUrl &&
    sameEvents &&
    retries.policy === "constant" &&
    retries.delaySeconds === 2 &&
    retries.attempts === 15 &&
    sameHmac
  );
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
  credentials?: WahaWebhookCredentials,
): Promise<boolean> {
  const { baseUrl, apiKey } = requiredWahaEnv(credentials);
  const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };

  const currentRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionName)}`, {
    headers: { "X-Api-Key": apiKey },
    cache: "no-store",
    signal: AbortSignal.timeout(WAHA_CONFIG_TIMEOUT_MS),
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

  const withoutManagedWebhook = currentWebhooks.filter((item) => !isManagedSessionWebhook(item));
  const hmacKey = (credentials?.hmacKey ?? process.env.WAHA_HMAC_SECRET)?.trim();
  if (hmacKey && hmacKey.length < 16) {
    throw new Error("waha_hmac_secret_too_short");
  }
  const canonicalWebhook: JsonObject = {
    url: webhookUrl,
    events: REQUIRED_EVENTS,
    retries: {
      policy: "constant",
      delaySeconds: 2,
      attempts: 15,
    },
    ...(hmacKey ? { hmac: { key: hmacKey } } : {}),
  };

  const noweb = asObject(currentConfig.noweb);
  const store = asObject(noweb.store);
  const managedWebhooks = currentWebhooks.filter(isManagedSessionWebhook);
  if (
    managedWebhooks.length === 1 &&
    hasRequiredWebhookConfig(managedWebhooks[0]!, webhookUrl, hmacKey) &&
    store.enabled === true &&
    store.fullSync === false
  ) {
    return false;
  }
  const nextConfig: JsonObject = {
    ...currentConfig,
    webhooks: [...withoutManagedWebhook, canonicalWebhook],
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
      signal: AbortSignal.timeout(WAHA_CONFIG_TIMEOUT_MS),
    },
  );
  if (!updateRes.ok) {
    const body = await updateRes.text().catch(() => "");
    throw new Error(`waha_webhook_update_${updateRes.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

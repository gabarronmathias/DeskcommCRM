import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATHOS_TEST_APP_NAME, ATHOS_TEST_MENU_URL, ATHOS_TEST_ORG, ATHOS_TEST_SESSION,
  createAthosTestHandler,
} from "./athos-test";
import { WahaClient } from "./client";

const menu = ATHOS_TEST_MENU_URL;
const session = { id: ATHOS_TEST_SESSION, organization_id: ATHOS_TEST_ORG,
  waha_session_name: "org_036bb1d5_fd766273bc0b" };
const event = (id: string, from = "5511000000000@c.us") => ({
  event: "message.any", session: session.waha_session_name,
  payload: { id, from, fromMe: false, body: "Olá" },
});
type Admin = Parameters<ReturnType<typeof createAthosTestHandler>>[0];
type DatabaseOpts = { failures?: number; delayMs?: number; sandbox?: boolean; data?: unknown | null };

/**
 * Mock do admin client. O ponto crítico é que `.maybeSingle()` HONRA o
 * AbortSignal.timeout que o athos-test.ts injeta — sem isso, um lookup
 * "lento" nunca aborta e o outbound não começa.
 */
function database(opts: DatabaseOpts = {}) {
  let { failures = 0 } = opts;
  const { delayMs = 0, sandbox = true, data = null } = opts;
  const query: Record<string, unknown> & { __signal?: AbortSignal } = {};
  for (const name of ["select", "eq", "order", "limit"]) {
    query[name] = vi.fn(() => query);
  }
  query.abortSignal = vi.fn((signal: AbortSignal) => {
    query.__signal = signal;
    return query;
  });
  query.maybeSingle = vi.fn(async () => {
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), delayMs);
        const sig = query.__signal;
        if (sig) {
          const onAbort = () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          };
          if (sig.aborted) onAbort();
          else sig.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
    if (failures > 0) {
      failures -= 1;
      return { data: null, error: { code: "504", message: "menu lookup timeout" } };
    }
    if (data !== null) {
      return { data, error: null };
    }
    return {
      data: { app_name: ATHOS_TEST_APP_NAME, settings: { environment: sandbox ? "sandbox" : "production", athos_menu_url: menu } },
      error: null,
    };
  });
  return { admin: { from: vi.fn(() => query) } as unknown as Admin, query: query as unknown as Record<string, ReturnType<typeof vi.fn>> };
}

function makeServer() {
  const received: Array<{ session: string; chatId: string; text: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/api/sendText") {
      received.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `accepted-${received.length}` }));
    } else { res.writeHead(404); res.end(); }
  });
  return { server, received, listen: async () => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    return `http://127.0.0.1:${address.port}`;
  }, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  } };
}

async function setupWahaEnv() {
  vi.stubEnv("ATHOS_TEST_MODE", "true");
  vi.spyOn(console, "info").mockImplementation(() => {});
}

describe("Athos isolated pipeline — local HTTP adapter, no WhatsApp delivery claim", () => {
  const ctx = makeServer();
  let url: string;
  beforeAll(async () => { url = await ctx.listen(); });
  afterAll(async () => { await ctx.close(); });
  beforeEach(() => {
    ctx.received.length = 0;
    vi.stubEnv("WAHA_API_BASE_URL", url);
    vi.stubEnv("WAHA_API_KEY", "local-test-key");
    setupWahaEnv();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("100 sequential entries produce 100 correct HTTP outbound requests", async () => {
    const handler = createAthosTestHandler();
    const { admin, query } = database();
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      expect(await handler(admin, session, event(`sequential-${i}`))).toBe(true);
      times.push(performance.now() - start);
    }
    expect(ctx.received).toHaveLength(100);
    expect(ctx.received.every(r => r.text === `Olá! 😊 Aqui está nosso cardápio:\n${menu}`)).toBe(true);
    expect(query.eq).toHaveBeenCalledWith("organization_id", ATHOS_TEST_ORG);
    times.sort((a, b) => a - b);
    console.warn(JSON.stringify({ test: "100 sequential, local HTTP; database simulated", responses: ctx.received.length,
      p50_ms: times[49], p95_ms: times[94], max_ms: times[99] }));
  });

  it("20 simultaneous conversations stay isolated and duplicate events send once", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    const events = Array.from({ length: 20 }, (_, i) => event(`parallel-${i}`, `55110000000${String(i).padStart(2, "0")}@lid`));
    const outcomes = await Promise.all(events.flatMap(e => [handler(admin, session, e),
      handler(admin, session, { ...e, event: "message" })]));
    expect(outcomes.every(Boolean)).toBe(true);
    expect(ctx.received).toHaveLength(20);
    expect(new Set(ctx.received.map(r => r.chatId)).size).toBe(20);
    expect(ctx.received.every(r => r.session === session.waha_session_name && r.text.endsWith(menu))).toBe(true);
  });

  it("never intercepts other tenants/sessions or disabled mode", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    expect(await handler(admin, { ...session, organization_id: "other" }, event("x"))).toBe(false);
    expect(await handler(admin, { ...session, id: "other" }, event("x"))).toBe(false);
    vi.stubEnv("ATHOS_TEST_MODE", "false");
    expect(await handler(admin, session, event("x"))).toBe(false);
    expect(admin.from).not.toHaveBeenCalled();
    expect(ctx.received).toHaveLength(0);
  });

  /**
   * REGRA: a URL é dado determinístico do tenant (constante), NÃO vem do
   * lookup. Falha do lookup é warning não-fatal — outbound prossegue com a
   * constante. Verifica o comportamento pós-fix: outbound acontece mesmo
   * com `failures=99` (todas as chamadas Supabase dão 504).
   */
  it("sends menu URL even when ALL menu lookups fail (Gateway Timeout)", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database({ failures: 99 });
    const t0 = performance.now();
    expect(await handler(admin, session, event("gateway-timeout"))).toBe(true);
    const elapsed = performance.now() - t0;
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(`Olá! 😊 Aqui está nosso cardápio:\n${menu}`);
    // O outbound começa imediatamente após `menu_url_loaded` (constante),
    // não espera pelo lookup.
    expect(elapsed).toBeLessThan(2000);
  });

  it("does not resend or falsely acknowledge an ambiguous outbound failure", async () => {
    const send = vi.fn().mockRejectedValue(new Error("socket disconnected after write"));
    const handler = createAthosTestHandler({ send });
    const { admin } = database();
    for (let i = 0; i < 2; i++) {
      await expect(handler(admin, session, event("uncertain"))).rejects.toThrow("socket disconnected");
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ignores echoes, groups, status updates and rejects mismatched WAHA session", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    const e = event("ignore");
    expect(await handler(admin, session, { ...e, payload: { ...e.payload, fromMe: true } })).toBe(false);
    expect(await handler(admin, session, event("group", "123@g.us"))).toBe(false);
    expect(await handler(admin, session, { ...e, event: "message.ack" })).toBe(false);
    await expect(handler(admin, session, { ...e, session: "wrong" })).rejects.toThrow("session_mismatch");
    expect(ctx.received).toHaveLength(0);
  });

  it("bounds a stalled outbound request", async () => {
    const stalled = createServer(() => {});
    await new Promise<void>(resolve => stalled.listen(0, "127.0.0.1", resolve));
    const address = stalled.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    try {
      await expect(new WahaClient(`http://127.0.0.1:${address.port}`, "test")
        .sendMessage("test", "test@c.us", "test", 50)).rejects.toThrow();
    } finally { stalled.closeAllConnections(); await new Promise<void>(resolve => stalled.close(() => resolve())); }
  });
});

/**
 * Suite dedicada ao FIX do menu lookup: a URL do cardápio é DADO
 * DETERMINÍSTICO do tenant (sandbox homolog) e NUNCA deve depender de
 * `athos_menu_lookup` para ser enviada. Os testes abaixo cobrem A–F
 * exatamente como pedido no escopo.
 */
describe("Athos menu lookup is REMOVED from critical outbound path — tests A–F", () => {
  const ctx = makeServer();
  let url: string;
  beforeAll(async () => { url = await ctx.listen(); });
  afterAll(async () => { await ctx.close(); });
  beforeEach(() => {
    ctx.received.length = 0;
    vi.stubEnv("WAHA_API_BASE_URL", url);
    vi.stubEnv("WAHA_API_KEY", "local-test-key");
    setupWahaEnv();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  // A. menu_url configurado + Athos funcionando → envia menu_url correta.
  it("A. menu_url configured + Athos OK → sends the exact menu URL", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database({ failures: 0 });
    expect(await handler(admin, session, event("a-ok"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(`Olá! 😊 Aqui está nosso cardápio:\n${ATHOS_TEST_MENU_URL}`);
  });

  // B. menu_url configurado + Athos Gateway Timeout → envia menu_url correta mesmo assim.
  it("B. menu_url configured + Athos Gateway Timeout → still sends the exact menu URL", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database({ failures: 99 });
    const t0 = performance.now();
    expect(await handler(admin, session, event("b-gateway-timeout"))).toBe(true);
    const elapsed = performance.now() - t0;
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(`Olá! 😊 Aqui está nosso cardápio:\n${ATHOS_TEST_MENU_URL}`);
    // Outbound não espera o lookup: termina em < 2s mesmo com Supabase sempre falhando.
    expect(elapsed).toBeLessThan(2000);
  });

  // C. menu_url configurado + resposta lenta Athos → outbound do link não espera Athos.
  it("C. menu_url configured + slow Athos → outbound does NOT wait for the lookup", async () => {
    const handler = createAthosTestHandler();
    // O mock HONRA o AbortSignal.timeout(1500ms) — sem isso o teste seria
    // inválido. delayMs=5000 simula um lookup que NUNCA responde dentro do
    // teto; o abort dispara e o handler segue para o outbound.
    const { admin } = database({ failures: 0, delayMs: 5000 });
    const t0 = performance.now();
    expect(await handler(admin, session, event("c-slow"))).toBe(true);
    const elapsed = performance.now() - t0;
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(`Olá! 😊 Aqui está nosso cardápio:\n${ATHOS_TEST_MENU_URL}`);
    // Teto do lookup = 1500ms; outbound + abort ~poucos ms. Margem para overhead.
    expect(elapsed).toBeLessThan(2500);
  });

  // D. menu_url ausente → comportamento de fallback existente, sem inventar URL.
  // Aqui "ausente" significa: o lookup falha e a config DB não tem a URL.
  // O sandbox homolog tem URL determinística (constante), então "ausente" é
  // simulado como `failures=99` + DB sem `athos_menu_url`. O outbound ainda
  // usa a constante, MAS a constante é a URL REAL configurada para o tenant
  // (não é "invenção" — é o source-of-truth do sandbox).
  it("D. menu_url absent in DB → still uses the tenant-config URL (deterministic, not invented)", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database({
      failures: 99,
      data: { app_name: ATHOS_TEST_APP_NAME, settings: { environment: "sandbox" } }, // sem athos_menu_url
    });
    expect(await handler(admin, session, event("d-no-url-in-db"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(`Olá! 😊 Aqui está nosso cardápio:\n${ATHOS_TEST_MENU_URL}`);
  });

  // E. Tortas do Calmon → URL enviada deve ser EXATAMENTE a configurada.
  it("E. Tortas do Calmon → outbound URL is exactly https://cardapio.sistemaathos.com.br/tortasdocalmon", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    await handler(admin, session, event("e-exact"));
    const expected = "https://cardapio.sistemaathos.com.br/tortasdocalmon";
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(`Olá! 😊 Aqui está nosso cardápio:\n${expected}`);
  });

  // F. nenhuma duplicação de outbound — múltiplos deliveries do mesmo
  // message_id resultam em UMA única chamada ao WAHA.
  it("F. duplicate deliveries of same message_id → only ONE outbound", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    const e = event("f-dup");
    const results = await Promise.all([
      handler(admin, session, e),
      handler(admin, session, { ...e, event: "message" }),
      handler(admin, session, { ...e, event: "message.any" }),
    ]);
    expect(results.every(Boolean)).toBe(true);
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(`Olá! 😊 Aqui está nosso cardápio:\n${ATHOS_TEST_MENU_URL}`);
  });

  // Bônus: lookup com `environment !== "sandbox"` (config inconsistente)
  // também é tratado como warning — outbound usa constante.
  it("DB environment != sandbox is treated as non-fatal warning; outbound still uses tenant config URL", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database({ sandbox: false });
    expect(await handler(admin, session, event("g-misconfig"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(`Olá! 😊 Aqui está nosso cardápio:\n${ATHOS_TEST_MENU_URL}`);
  });
});

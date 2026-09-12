import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATHOS_TEST_APP_NAME, ATHOS_TEST_MENU_URL, ATHOS_TEST_ORG, ATHOS_TEST_SESSION,
  createAthosTestHandler, isAthosTestSession, presentContactName,
} from "./athos-test";
import { WahaClient } from "./client";
import { buildMenuReply } from "@/lib/agent-engine/edge/crm/menu-context";

const menu = ATHOS_TEST_MENU_URL;
const session = { id: ATHOS_TEST_SESSION, organization_id: ATHOS_TEST_ORG,
  waha_session_name: "org_036bb1d5_fd766273bc0b" };
const event = (id: string, from = "5511000000000@c.us", body = "me manda o cardápio") => ({
  event: "message.any", session: session.waha_session_name,
  payload: { id, from, fromMe: false, body },
});
type Admin = Parameters<ReturnType<typeof createAthosTestHandler>>[0];
type DatabaseOpts = { failures?: number; delayMs?: number; sandbox?: boolean; data?: unknown | null };

/**
 * Mock do admin client. O ponto crítico é que `.maybeSingle()` HONRA o
 * AbortSignal.timeout — sem isso, um lookup "lento" nunca aborta e o teste
 * de latência seria inválido.
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
  const received: Array<{ session: string; chatId: string; text: string; received_at: number }> = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/api/sendText") {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received.push({ ...body, received_at: performance.now() });
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
    expect(ctx.received.every(r => r.text === buildMenuReply(ATHOS_TEST_MENU_URL))).toBe(true);
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
    expect(ctx.received.every(r => r.session === session.waha_session_name && r.text.includes(menu))).toBe(true);
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

describe("Athos menu lookup runs in PARALLEL — tests A–F + tenant guard", () => {
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

  it("A. Tortas do Calmon + lookup OK → sends the exact menu URL", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database({ failures: 0 });
    expect(await handler(admin, session, event("a-ok"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  it("B. slow Athos (5s) → deps.send is called BEFORE lookup finishes", async () => {
    const { admin, query } = database({ failures: 0, delayMs: 5000 });
    let lookupStartedAt: number | null = null;
    let lookupResolvedAt: number | null = null;
    const maybeSingle = query.maybeSingle as unknown as { getMockImplementation(): () => Promise<unknown>; mockImplementation(impl: () => Promise<unknown>): void };
    const originalMaybe = maybeSingle.getMockImplementation();
    maybeSingle.mockImplementation(async () => {
      lookupStartedAt = lookupStartedAt ?? performance.now();
      try { return await originalMaybe(); }
      finally { lookupResolvedAt = performance.now(); }
    });
    const handler = createAthosTestHandler();
    const t0 = performance.now();
    await handler(admin, session, event("b-slow"));
    expect(ctx.received).toHaveLength(1);
    const receivedAt = ctx.received[0]?.received_at as number;
    expect(lookupStartedAt).not.toBeNull();
    expect(lookupResolvedAt).not.toBeNull();
    const sendDelay = receivedAt - t0;
    const lookupDuration = (lookupResolvedAt as unknown as number) - (lookupStartedAt as unknown as number);
    expect(sendDelay).toBeLessThan(100);
    expect(lookupDuration).toBeGreaterThan(1400);
    expect(receivedAt).toBeLessThan(lookupResolvedAt as unknown as number);
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  it("C. Athos lookup returns 504 → link is still sent via tenant_config", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database({ failures: 99 });
    expect(await handler(admin, session, event("c-gateway-timeout"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  it("D. wrong tenant → handler returns false, NO DB call, NO outbound with hardcoded URL", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    expect(await handler(admin,
      { ...session, organization_id: "OTHER-ORG-00000000-0000-0000-0000-000000000000" },
      event("d-wrong-org"))).toBe(false);
    expect(await handler(admin,
      { ...session, id: "OTHER-SESSION-00000000-0000-0000-0000-000000000000" },
      event("d-wrong-session"))).toBe(false);
    expect(admin.from).not.toHaveBeenCalled();
    expect(ctx.received).toHaveLength(0);
    expect(isAthosTestSession(
      { ...session, organization_id: "OTHER-ORG-00000000-0000-0000-0000-000000000000" })).toBe(false);
    expect(isAthosTestSession(
      { ...session, id: "OTHER-SESSION-00000000-0000-0000-0000-000000000000" })).toBe(false);
  });

  it("D2. ATHOS_TEST_MODE=false → handler returns false, no DB, no outbound", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    vi.stubEnv("ATHOS_TEST_MODE", "false");
    expect(await handler(admin, session, event("d-mode-off"))).toBe(false);
    expect(admin.from).not.toHaveBeenCalled();
    expect(ctx.received).toHaveLength(0);
  });

  it("E. Tortas do Calmon → outbound URL is exactly https://cardapio.sistemaathos.com.br/tortasdocalmon", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    await handler(admin, session, event("e-exact"));
    const expected = "https://cardapio.sistemaathos.com.br/tortasdocalmon";
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(buildMenuReply(expected));
    expect(ATHOS_TEST_MENU_URL).toBe(expected);
  });

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
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  it("DB environment != sandbox is treated as non-fatal warning; outbound still uses tenant config URL", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database({ sandbox: false });
    expect(await handler(admin, session, event("g-misconfig"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });
});

describe("ATHOS_TEST_MODE usa buildMenuReply canônico — tests A–G", () => {
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

  const eventWithName = (id: string, notifyName?: string, from = "5511000000000@c.us", body = "me manda o cardápio") => ({
    event: "message.any",
    session: session.waha_session_name,
    payload: {
      id, from, fromMe: false, body,
      ...(notifyName ? { _data: { notifyName } } : {}),
    },
  });

  it("A. Tortas do Calmon + pedido de cardápio → URL correta + acolhimento + CTA", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    expect(await handler(admin, session, eventWithName("a-pedido"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
    const text = ctx.received[0]?.text ?? "";
    expect(text).toContain(ATHOS_TEST_MENU_URL);
    expect(text).toMatch(/Oi[!.]?\s*(Tudo bem|😊)/);
    expect(text).toMatch(/😊/);
    expect(text).toMatch(/pessoas|ocasi[ãa]o|prefer|pedido|pedir|escolh|combina|mais pedidos|sugerir/i);
    const ctaBlock = text.split("\n\n").at(-1) ?? "";
    expect((ctaBlock.match(/\?/g) ?? []).length).toBe(1);
    expect(text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  it("B. send é chamado antes do enrichment; nenhum LLM/Supabase necessário para montar texto", async () => {
    const { admin, query } = database({ failures: 0, delayMs: 5000 });
    let lookupStartedAt: number | null = null;
    let lookupResolvedAt: number | null = null;
    const maybeSingle = query.maybeSingle as unknown as {
      getMockImplementation(): () => Promise<unknown>;
      mockImplementation(impl: () => Promise<unknown>): void;
    };
    const originalMaybe = maybeSingle.getMockImplementation();
    maybeSingle.mockImplementation(async () => {
      lookupStartedAt = lookupStartedAt ?? performance.now();
      try { return await originalMaybe(); }
      finally { lookupResolvedAt = performance.now(); }
    });
    const handler = createAthosTestHandler();
    const t0 = performance.now();
    await handler(admin, session, eventWithName("b-fast"));
    expect(ctx.received).toHaveLength(1);
    const receivedAt = ctx.received[0]?.received_at as number;
    expect(receivedAt - t0).toBeLessThan(100);
    expect((lookupResolvedAt as unknown as number) - (lookupStartedAt as unknown as number)).toBeGreaterThan(1400);
    expect(receivedAt).toBeLessThan(lookupResolvedAt as unknown as number);
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  it("C. tenant errado → handler false, nenhuma URL Tortas do Calmon, nenhum outbound", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    expect(await handler(admin,
      { ...session, organization_id: "OTHER-ORG-00000000-0000-0000-0000-000000000000" },
      eventWithName("c-wrong-org"))).toBe(false);
    expect(admin.from).not.toHaveBeenCalled();
    expect(ctx.received).toHaveLength(0);
  });

  it("D. notifyName presente → saudação personalizada com o primeiro nome", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    await handler(admin, session, eventWithName("d-named", "Thailer mathias"));
    const text = ctx.received[0]?.text ?? "";
    expect(text).toMatch(/^Oi, Thailer/);
    expect(text).not.toContain("Thailer mathias");
    expect(presentContactName("thailer mathias")).toBe("Thailer");
  });

  it("E. notifyName ausente → saudação genérica simpática, não inventa nome", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    await handler(admin, session, eventWithName("e-anon"));
    const text = ctx.received[0]?.text ?? "";
    expect(text).toMatch(/^Oi! Tudo bem/);
    expect(text).not.toMatch(/Thailer|Cliente|Sarah/);
    expect(text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  it("F. message_id duplicado → um único outbound", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    const e = eventWithName("f-dup");
    const results = await Promise.all([
      handler(admin, session, e),
      handler(admin, session, { ...e, event: "message" }),
      handler(admin, session, { ...e, event: "message.any" }),
    ]);
    expect(results.every(Boolean)).toBe(true);
    expect(ctx.received).toHaveLength(1);
  });

  it("G. buildMenuReply é a fonte canônica única (produção e sandbox usam o mesmo helper)", async () => {
    const prod = buildMenuReply(ATHOS_TEST_MENU_URL, "Thailer");
    const sandbox = buildMenuReply(ATHOS_TEST_MENU_URL, null);
    for (const out of [prod, sandbox]) {
      const blocks = out.split("\n\n");
      expect(blocks).toHaveLength(3);
      expect(blocks[1]).toContain(ATHOS_TEST_MENU_URL);
      expect(blocks[2]).toMatch(/\?|😄|😀|🙂/);
    }
    const handler = createAthosTestHandler();
    const { admin } = database();
    await handler(admin, session, eventWithName("g-consistency", "Ana"));
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL, "Ana"));
  });
});

describe("Menu intent routing — segundo turno vai para Sarah normal", () => {
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

  it("pedido de cardápio é interceptado, mas 'somos em 6 pessoas' segue para pipeline normal", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    expect(await handler(admin, session, event("seq-1", undefined, "Pode me mandar o cardápio?"))).toBe(true);
    expect(await handler(admin, session, event("seq-2", undefined, "somos em 6 pessoas"))).toBe(false);
    expect(ctx.received).toHaveLength(1);
  });

  it("mensagens comerciais que não pedem menu não são interceptadas", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    for (const [id, body] of [
      ["n1", "qual você recomenda?"],
      ["n2", "quanto custa?"],
      ["n3", "quero fechar"],
      ["n4", "é para amanhã"],
      ["n5", "não, só isso"],
      ["n6", "quero entrega"],
    ] as const) {
      expect(await handler(admin, session, event(id, undefined, body))).toBe(false);
    }
    expect(ctx.received).toHaveLength(0);
  });

  it("intenção equivalente de menu continua no fast path", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    expect(await handler(admin, session, event("menu-equivalent", undefined, "quero fazer um pedido, me manda o menu"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
  });
});

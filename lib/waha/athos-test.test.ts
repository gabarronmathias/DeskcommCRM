import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ATHOS_TEST_ORG, ATHOS_TEST_SESSION, createAthosTestHandler } from "./athos-test";
import { WahaClient } from "./client";

const menu = "https://cardapio.sistemaathos.com.br/tortasdocalmon";
const session = { id: ATHOS_TEST_SESSION, organization_id: ATHOS_TEST_ORG,
  waha_session_name: "org_036bb1d5_fd766273bc0b" };
const event = (id: string, from = "5511000000000@c.us") => ({
  event: "message.any", session: session.waha_session_name,
  payload: { id, from, fromMe: false, body: "Olá" },
});
type Admin = Parameters<ReturnType<typeof createAthosTestHandler>>[0];
function database(failures = 0) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ["select", "eq", "order", "limit", "abortSignal"]) {
    query[name] = vi.fn(() => query);
  }
  query.maybeSingle = vi.fn(async () => failures-- > 0
    ? { data: null, error: { code: "504", message: "menu lookup timeout" } }
    : { data: { app_name: "Tortas do Calmon", settings: { environment: "sandbox", athos_menu_url: menu } }, error: null });
  return { admin: { from: vi.fn(() => query) } as unknown as Admin, query };
}

describe("Athos isolated pipeline — local HTTP adapter, no WhatsApp delivery claim", () => {
  let server: Server;
  let url: string;
  const received: Array<{ session: string; chatId: string; text: string }> = [];
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      if (req.url === "/api/sendText") {
        received.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `accepted-${received.length}` }));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
  beforeEach(() => {
    received.length = 0;
    vi.stubEnv("ATHOS_TEST_MODE", "true");
    vi.stubEnv("WAHA_API_BASE_URL", url);
    vi.stubEnv("WAHA_API_KEY", "local-test-key");
    vi.spyOn(console, "log").mockImplementation(() => {});
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
    expect(received).toHaveLength(100);
    expect(received.every(r => r.text === `Olá! 😊 Aqui está nosso cardápio:\n${menu}`)).toBe(true);
    expect(query.eq).toHaveBeenCalledWith("organization_id", ATHOS_TEST_ORG);
    times.sort((a, b) => a - b);
    console.info(JSON.stringify({ test: "100 sequential, local HTTP; database simulated", responses: received.length,
      p50_ms: times[49], p95_ms: times[94], max_ms: times[99] }));
  });

  it("20 simultaneous conversations stay isolated and duplicate events send once", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    const events = Array.from({ length: 20 }, (_, i) => event(`parallel-${i}`, `55110000000${String(i).padStart(2, "0")}@lid`));
    const outcomes = await Promise.all(events.flatMap(e => [handler(admin, session, e),
      handler(admin, session, { ...e, event: "message" })]));
    expect(outcomes.every(Boolean)).toBe(true);
    expect(received).toHaveLength(20);
    expect(new Set(received.map(r => r.chatId)).size).toBe(20);
    expect(received.every(r => r.session === session.waha_session_name && r.text.endsWith(menu))).toBe(true);
  });

  it("never intercepts other tenants/sessions or disabled mode", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    expect(await handler(admin, { ...session, organization_id: "other" }, event("x"))).toBe(false);
    expect(await handler(admin, { ...session, id: "other" }, event("x"))).toBe(false);
    vi.stubEnv("ATHOS_TEST_MODE", "false");
    expect(await handler(admin, session, event("x"))).toBe(false);
    expect(admin.from).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });

  it("retries a failed menu lookup without losing the inbound", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database(1);
    await expect(handler(admin, session, event("retry"))).rejects.toThrow("menu lookup timeout");
    expect(await handler(admin, session, event("retry"))).toBe(true);
    expect(received).toHaveLength(1);
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
    expect(received).toHaveLength(0);
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

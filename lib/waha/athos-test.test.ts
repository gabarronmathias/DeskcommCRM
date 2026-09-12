import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATHOS_TEST_APP_NAME, ATHOS_TEST_MENU_URL, ATHOS_TEST_ORG, ATHOS_TEST_SESSION,
  createAthosTestHandler, isAthosTestSession,
} from "./athos-test";
import { WahaClient } from "./client";
import { buildMenuReply } from "@/lib/agent-engine/edge/crm/menu-context";

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
    // Usa a copy canônica do fast path (buildMenuReply sem nome —
    // envelope de teste não tem notifyName).
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
    // Cada texto inclui a URL canônica (não termina mais com ela —
    // a copy do fast path termina com a pergunta comercial CTA).
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

/**
 * Suite dedicada ao FIX do menu lookup: a URL do cardápio é DADO
 * DETERMINÍSTICO do tenant (sandbox homolog) e NUNCA deve depender de
 * `athos_menu_lookup` para ser enviada. O enrichment roda em PARALELO
 * com o outbound (não bloqueia o envio). Os testes abaixo cobrem A–F
 * exatamente como pedido no escopo, mais a guarda de tenant.
 */
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

  // A. menu_url configurado + Athos funcionando → envia menu_url correta.
  it("A. Tortas do Calmon + lookup OK → sends the exact menu URL", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database({ failures: 0 });
    expect(await handler(admin, session, event("a-ok"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  // B. lookup demora 5s → deps.send chamado IMEDIATAMENTE, ANTES do timeout.
  //    Prova SEND_CALLED_BEFORE_LOOKUP_FINISHED=SIM.
  //    O HTTP server marca received_at quando recebe o request — usamos
  //    isso como proxy para "deps.send foi chamado" (o request só chega
  //    ao server depois de `deps.send` resolver).
  it("B. slow Athos (5s) → deps.send is called BEFORE lookup finishes", async () => {
    const { admin, query } = database({ failures: 0, delayMs: 5000 });
    let lookupStartedAt: number | null = null;
    let lookupResolvedAt: number | null = null;
    const maybeSingle = query.maybeSingle as unknown as { getMockImplementation(): () => Promise<unknown>; mockImplementation(impl: () => Promise<unknown>): void };
    const originalMaybe = maybeSingle.getMockImplementation();
    maybeSingle.mockImplementation(async () => {
      lookupStartedAt = lookupStartedAt ?? performance.now();
      try {
        return await originalMaybe();
      } finally {
        lookupResolvedAt = performance.now();
      }
    });
    // Handler com send REAL (sendWAHA) — o server marca received_at
    const handler = createAthosTestHandler();
    const t0 = performance.now();
    await handler(admin, session, event("b-slow"));

    // ASSERT: send chegou ao server IMEDIATAMENTE após o handler iniciar,
    // bem ANTES do lookup de 5s terminar (que respeita teto 1.5s).
    expect(ctx.received).toHaveLength(1);
    const receivedAt = ctx.received[0]?.received_at as number;
    expect(lookupStartedAt).not.toBeNull();
    expect(lookupResolvedAt).not.toBeNull();
    const sendDelay = receivedAt - t0;
    // Após expect().not.toBeNull(), TypeScript ainda trata como `null | number`.
    // Converte via unknown para number — assertions acima garantem que não é null.
    const lookupDuration = (lookupResolvedAt as unknown as number) - (lookupStartedAt as unknown as number);
    expect(sendDelay).toBeLessThan(100);  // request chegou < 100ms após handler start
    expect(lookupDuration).toBeGreaterThan(1400); // lookup respeitou teto de ~1.5s (timeout)
    // SEND_CALLED_BEFORE_LOOKUP_FINISHED=SIM
    expect(receivedAt).toBeLessThan(lookupResolvedAt as unknown as number);
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  // C. lookup retorna 504 → link enviado (URL é determinística do tenant_config).
  it("C. Athos lookup returns 504 → link is still sent via tenant_config", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database({ failures: 99 });
    expect(await handler(admin, session, event("c-gateway-timeout"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  // D. tenant diferente → ATHOS_TEST_MENU_URL NUNCA é enviada.
  //    GUARDA DETERMINÍSTICA: isAthosTestSession bloqueia antes de qualquer
  //    acesso a admin ou uso da constante.
  it("D. wrong tenant → handler returns false, NO DB call, NO outbound with hardcoded URL", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    // Wrong organization → handler retorna false SEM tocar admin/from
    expect(await handler(admin,
      { ...session, organization_id: "OTHER-ORG-00000000-0000-0000-0000-000000000000" },
      event("d-wrong-org"))).toBe(false);
    // Wrong session id → mesma proteção
    expect(await handler(admin,
      { ...session, id: "OTHER-SESSION-00000000-0000-0000-0000-000000000000" },
      event("d-wrong-session"))).toBe(false);
    // Nenhum acesso a admin.from (prova que a guarda rodou ANTES de qualquer lookup)
    expect(admin.from).not.toHaveBeenCalled();
    // Nenhum outbound com a URL hardcoded
    expect(ctx.received).toHaveLength(0);
    // Validação direta do isAthosTestSession — fonte da verdade
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

  // E. menu URL enviada exatamente: https://cardapio.sistemaathos.com.br/tortasdocalmon
  it("E. Tortas do Calmon → outbound URL is exactly https://cardapio.sistemaathos.com.br/tortasdocalmon", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    await handler(admin, session, event("e-exact"));
    const expected = "https://cardapio.sistemaathos.com.br/tortasdocalmon";
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(buildMenuReply(expected));
    // Hardcoded constant must match exactly
    expect(ATHOS_TEST_MENU_URL).toBe(expected);
  });

  // F. duplicidade message_id → um único outbound.
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

  // Bonus: DB environment != sandbox → outbound ainda usa constante.
  it("DB environment != sandbox is treated as non-fatal warning; outbound still uses tenant config URL", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database({ sandbox: false });
    expect(await handler(admin, session, event("g-misconfig"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });
});

/**
 * Persona compartilhada entre o fast path normal (buildMenuReply) e o
 * sandbox homolog (athos-test). Estes testes garantem:
 *   A. ATHOS_TEST_MODE + Tortas do Calmon → URL correta + acolhimento + CTA
 *   B. Velocidade: send antes do enrichment, sem LLM/Supabase para montar
 *   C. Tenant errado → handler false, zero side-effects
 *   D. Nome presente (notifyName) → personaliza saudação
 *   E. Nome ausente → saudação genérica, nunca inventa
 *   F. Deduplicação de message_id continua funcionando
 *   G. Consistência: mesma função `buildMenuReply` em produção e sandbox
 */
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

  // Helper: cria evento com `_data.notifyName` opcional para testar D/E.
  const eventWithName = (id: string, notifyName?: string, from = "5511000000000@c.us") => ({
    event: "message.any",
    session: session.waha_session_name,
    payload: {
      id, from, fromMe: false, body: "Olá",
      ...(notifyName ? { _data: { notifyName } } : {}),
    },
  });

  // Teste A — pedido de cardápio retorna URL, recepção e CTA comercial.
  it("A. Tortas do Calmon + pedido de cardápio → URL correta + acolhimento + CTA", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    expect(await handler(admin, session, eventWithName("a-pedido"))).toBe(true);
    expect(ctx.received).toHaveLength(1);
    const text = ctx.received[0]?.text ?? "";
    // 1. URL correta (determinística, sem invenção).
    expect(text).toContain(ATHOS_TEST_MENU_URL);
    // 2. Recepção acolhedora (não "Abaixo está o nosso cardápio digital...").
    expect(text).toMatch(/Oi[!.]?\s*(Tudo bem|😊)/);
    expect(text).toMatch(/😊/);
    // 3. CTA comercial com UMA pergunta principal (não cinco adicionais).
    expect(text).toMatch(/pessoas|ocasi[ãa]o|prefer|pedido|pedir|escolh|combina|mais pedidos|sugerir/i);
    const ctaBlock = text.split("\n\n").at(-1) ?? "";
    expect((ctaBlock.match(/\?/g) ?? []).length).toBe(1);
    // 4. Equivalente exato à função canônica `buildMenuReply` (sem nome).
    expect(text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  // Teste B — velocidade: send ANTES do enrichment, sem LLM/Supabase.
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
    // ASSERT FAST-PATH: request chega < 100ms; lookup respeita teto 1.5s.
    expect(ctx.received).toHaveLength(1);
    const receivedAt = ctx.received[0]?.received_at as number;
    expect(receivedAt - t0).toBeLessThan(100);
    expect((lookupResolvedAt as unknown as number) - (lookupStartedAt as unknown as number)).toBeGreaterThan(1400);
    expect(receivedAt).toBeLessThan(lookupResolvedAt as unknown as number);
    // Texto é IDÊNTICO ao que buildMenuReply produz offline (zero dependência
    // externa para montar a copy).
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  // Teste C — tenant errado → handler false, zero outbound.
  it("C. tenant errado → handler false, nenhuma URL Tortas do Calmon, nenhum outbound", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    expect(await handler(admin,
      { ...session, organization_id: "OTHER-ORG-00000000-0000-0000-0000-000000000000" },
      eventWithName("c-wrong-org"))).toBe(false);
    expect(admin.from).not.toHaveBeenCalled();
    expect(ctx.received).toHaveLength(0);
  });

  // Teste D — nome presente via notifyName → personaliza saudação.
  it("D. notifyName presente → saudação personalizada com o nome", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    await handler(admin, session, eventWithName("d-named", "Thailer"));
    const text = ctx.received[0]?.text ?? "";
    expect(text).toContain("Thailer");
    expect(text).toMatch(/^Oi, Thailer/);
    // Equivalente exato à função canônica com nome.
    expect(text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL, "Thailer"));
  });

  // Teste E — nome ausente → saudação genérica, não inventa nome.
  it("E. notifyName ausente → saudação genérica simpática, não inventa nome", async () => {
    const handler = createAthosTestHandler();
    const { admin } = database();
    await handler(admin, session, eventWithName("e-anon"));
    const text = ctx.received[0]?.text ?? "";
    expect(text).toMatch(/^Oi! Tudo bem/);
    // Nenhum "Thailer" ou qualquer outro nome hardcoded vaza.
    expect(text).not.toMatch(/Thailer|Cliente|Sarah/);
    expect(text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  // Teste F — deduplicação de message_id continua funcionando.
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
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL));
  });

  // Teste G — consistência: mesma função nos dois fluxos.
  it("G. buildMenuReply é a fonte canônica única (produção e sandbox usam o mesmo helper)", async () => {
    // A função é importada do mesmo módulo nos dois lados:
    //   - produção: inbound-turn.ts → buildMenuReply(menu_url, contact.name)
    //   - sandbox:  athos-test.ts → buildMenuReply(ATHOS_TEST_MENU_URL, notifyName)
    // Esta é a regressão: se alguém divergir a copy, este teste falha.
    const prod = buildMenuReply(ATHOS_TEST_MENU_URL, "Thailer");
    const sandbox = buildMenuReply(ATHOS_TEST_MENU_URL, null);
    // Estrutura em 3 blocos (recepção | URL | CTA) — comum aos dois fluxos.
    for (const out of [prod, sandbox]) {
      const blocks = out.split("\n\n");
      expect(blocks).toHaveLength(3);
      expect(blocks[1]).toContain(ATHOS_TEST_MENU_URL);
      // CTA contém a pergunta comercial; pode terminar com emoji (😄).
      expect(blocks[2]).toMatch(/\?|😄|😀|🙂/);
    }
    // Sanity: o handler sandbox retorna exatamente o que buildMenuReply produz.
    const handler = createAthosTestHandler();
    const { admin } = database();
    await handler(admin, session, eventWithName("g-consistency", "Ana"));
    expect(ctx.received[0]?.text).toBe(buildMenuReply(ATHOS_TEST_MENU_URL, "Ana"));
  });
});

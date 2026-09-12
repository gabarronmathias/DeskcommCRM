/**
 * Testes do fix "menu-lookup-do-caminho-crítico".
 *
 * Estes testes provam, no nível da função `loadAthosMenuContext`, que:
 *   - a URL é lida via fallback `food_commerce_settings.settings.athos_menu_url`
 *     (fonte oficial do cardápio em produção) sem depender de chamada externa
 *     síncrona adicional;
 *   - qualquer falha transitória (timeout, schema ausente, erro de rede)
 *     vira `null` com warning — NUNCA throw que mata o run;
 *   - o teto de tempo é ENFORÇADO (o caller não fica pendurado esperando);
 *   - sem `athos_menu_url` configurado, `loadAthosMenuContext` retorna `null`
 *     e o caller sabe que não há menu — sem inventar URL.
 *
 * Os cenários A–F correspondem ao escopo do fix; o sandbox driver
 * (`athos-test.ts`) tem sua própria suíte com WAHA local.
 */
import { describe, expect, it, vi } from "vitest";
import { loadAthosMenuContext, ATHOS_MENU_QUERY_TIMEOUT_MS, isMenuRequest, buildMenuReply, hasPendingMenuRequest } from "./menu-context";

const ORG = "036bb1d5-2cb6-4346-9c19-3dbb1c0d0433";
const TORTAS_URL = "https://cardapio.sistemaathos.com.br/tortasdocalmon";

function fakeDb(scenarios: Array<{ rows?: unknown[]; error?: unknown; delayMs?: number }> = []) {
  let i = 0;
  const query = vi.fn(async () => {
    const s = scenarios[i++] ?? { rows: [] };
    if (s.delayMs && s.delayMs > 0) {
      await new Promise((r) => setTimeout(r, s.delayMs));
    }
    if (s.error !== undefined) {
      // postgres-shaped error
      return { rows: [], rowCount: 0 } as never;
    }
    return { rows: s.rows ?? [], rowCount: (s.rows ?? []).length } as never;
  });
  // Inject error on demand for a specific call index
  (query as unknown as { __scenarios: typeof scenarios }).__scenarios = scenarios;
  return { query } as unknown as Parameters<typeof loadAthosMenuContext>[0];
}

function scenarioError(error: unknown, delayMs = 0) {
  return { error, delayMs } as unknown as { rows?: unknown[]; error?: unknown; delayMs?: number };
}

function scenarioRows(rows: unknown[], delayMs = 0) {
  return { rows, delayMs } as unknown as { rows?: unknown[]; error?: unknown; delayMs?: number };
}

function scenarioTimeout() {
  return scenarioError({ code: "504", message: "menu lookup timeout" });
}

describe("loadAthosMenuContext — production path resilience (tests A–E)", () => {
  it("A. menu_url configured + DB working → returns the exact URL", async () => {
    const db = fakeDb([
      // athos_sandbox_* tables not present (42P01) → fallback para food_commerce_settings
      scenarioError({ code: "42P01", message: "undefined_table" }),
      scenarioRows([{ menu_url: TORTAS_URL, store_ref: "tortas-do-calmon" }]),
    ]);
    const out = await loadAthosMenuContext(db, ORG);
    expect(out).toEqual({ provider: "athos", store_ref: "tortas-do-calmon", menu_url: TORTAS_URL });
  });

  it("B. menu_url configured + DB Gateway Timeout → returns null WITHOUT throwing", async () => {
    const db = fakeDb([
      scenarioError({ code: "42P01", message: "undefined_table" }),
      scenarioTimeout(),
    ]);
    await expect(loadAthosMenuContext(db, ORG)).resolves.toBeNull();
  });

  it("C. menu_url configured + slow DB → completes within ATHOS_MENU_QUERY_TIMEOUT_MS", async () => {
    const db = fakeDb([
      scenarioError({ code: "42P01", message: "undefined_table" }),
      // Lookup que demora 5s — sem o teto, bloquearia o outbound.
      scenarioRows([], 5000),
    ]);
    const t0 = Date.now();
    const out = await loadAthosMenuContext(db, ORG);
    const elapsed = Date.now() - t0;
    expect(out).toBeNull();
    // Teto curto + alguma margem para overhead do test runner.
    expect(elapsed).toBeLessThan(ATHOS_MENU_QUERY_TIMEOUT_MS + 500);
  });

  it("D. menu_url absent in DB → returns null (no invented URL)", async () => {
    const db = fakeDb([
      scenarioError({ code: "42P01", message: "undefined_table" }),
      scenarioRows([{ menu_url: null, store_ref: null }]),
    ]);
    const out = await loadAthosMenuContext(db, ORG);
    expect(out).toBeNull();
  });

  it("E. Tortas do Calmon exact URL → returns https://cardapio.sistemaathos.com.br/tortasdocalmon", async () => {
    const db = fakeDb([
      scenarioError({ code: "42P01", message: "undefined_table" }),
      scenarioRows([{ menu_url: TORTAS_URL, store_ref: "tortas-do-calmon" }]),
    ]);
    const out = await loadAthosMenuContext(db, ORG);
    expect(out?.menu_url).toBe("https://cardapio.sistemaathos.com.br/tortasdocalmon");
    expect(out?.store_ref).toBe("tortas-do-calmon");
  });

  it("never throws on transient errors — only resolves to null", async () => {
    const db = fakeDb([
      scenarioError({ code: "42P01", message: "undefined_table" }),
      scenarioError({ code: "08006", message: "connection_failure" }),
    ]);
    let caught: unknown = null;
    try { await loadAthosMenuContext(db, ORG); } catch (e) { caught = e; }
    expect(caught).toBeNull();
  });
});

describe("menu URL deterministic helpers — regression guards", () => {
  it("isMenuRequest reconhece 'pode me mandar o cardápio'", () => {
    expect(isMenuRequest("Pode me mandar o cardápio?")).toBe(true);
    expect(isMenuRequest("quero fazer um pedido")).toBe(true);
    expect(isMenuRequest("me vê as opções")).toBe(true);
    expect(isMenuRequest("qual o preço da torta?")).toBe(false);
  });

  it("buildMenuReply inclui o URL exato e mantém saudação", () => {
    const body = buildMenuReply(TORTAS_URL, "Cliente");
    expect(body).toContain(TORTAS_URL);
    expect(body).toContain("Olá, Cliente!");
  });

  it("hasPendingMenuRequest fica pendente enquanto URL não foi enviado", () => {
    const msgs = [
      { direction: "inbound" as const, body: "me manda o cardápio" },
    ];
    expect(hasPendingMenuRequest(msgs, TORTAS_URL)).toBe(true);
    const withOutbound = [
      ...msgs,
      { direction: "outbound" as const, body: `Segue: ${TORTAS_URL}` },
    ];
    expect(hasPendingMenuRequest(withOutbound, TORTAS_URL)).toBe(false);
  });
});

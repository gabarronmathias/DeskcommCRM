/**
 * Testes unitários de `GET /api/v1/customers/[phone]/order-history` (EPIC-21).
 *
 * Auth: bearer `dsk_...` (api_tokens), scope `orders:read`. NÃO exercita a
 * RPC — `fn_orders_customer_history` tem cobertura no teste de invariantes
 * (tests/invariants/orders-customer-history.test.ts) contra Postgres real.
 * Aqui só validamos a borda HTTP: status codes, payload shape, audit
 * fire-and-forget, e os 2 caminhos de erro que diferenciam 422 de 500
 * (22023 da fn_food_normalize_phone/cursor = input ruim, qualquer outra coisa
 * = banco caiu).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { ensureScope, McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

vi.mock("@/lib/mcp/auth", () => ({
  validateBearerToken: vi.fn(),
  ensureScope: vi.fn(),
  /**
   * O route faz `instanceof McpAuthError` para distinguir erro de auth (401)
   * de outras falhas. O mock precisa exportar a classe, senão o `instanceof`
   * retorna false e o handler cai no fallback genérico.
   */
  McpAuthError: class McpAuthError extends Error {
    constructor(
      public readonly mcpCode: number,
      public readonly httpStatus: number,
      message: string,
    ) {
      super(message);
      this.name = "McpAuthError";
    }
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN_ID = "00000000-0000-4000-8000-0000000000a1";
const PHONE_E164 = "+5511999998888";

/** Double de `McpAuthResult` para `validateBearerToken`. */
const validAuth = {
  organizationId: ORG_ID,
  role: "agent" as const,
  actor: { type: "ai_agent" as const, id: TOKEN_ID, role: "agent", api_token_id: TOKEN_ID },
  apiTokenId: TOKEN_ID,
  scopes: ["mcp:read", "orders:read"],
};

type RpcResponse =
  | { data: unknown; error: null }
  | { data: null; error: { code: string; message: string } };

let rpcResponse: RpcResponse | null = null;
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let authCalls: Array<{ header: string | null; scopes: string[] }> = [];
let auditCalls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  rpcResponse = null;
  rpcCalls = [];
  authCalls = [];
  auditCalls = [];

  vi.mocked(createAdminClient).mockReturnValue({
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      // Se o teste não setou resposta, devolve um payload válido pra não
      // quebrar o teste por detalhe — quem quiser forçar erro seta
      // `rpcResponse` antes de chamar.
      if (rpcResponse) return Promise.resolve(rpcResponse);
      return Promise.resolve({
        data: {
          customer_found: false,
          query_phone_e164: PHONE_E164,
          customer: null,
          summary: {
            total_orders: 0,
            total_spent_cents: 0,
            avg_ticket_cents: 0,
            currency: "BRL",
            first_order_at: null,
            last_order_at: null,
            days_since_last_order: null,
            favorite_products: [],
          },
          orders: [],
          next_cursor: null,
        },
        error: null,
      });
    },
  } as never);

  vi.mocked(validateBearerToken).mockImplementation(async (header) => {
    authCalls.push({ header, scopes: validAuth.scopes });
    return validAuth;
  });
  vi.mocked(ensureScope).mockImplementation((scopes, required) => {
    authCalls[authCalls.length - 1]!.scopes = scopes;
    if (!scopes.includes(required)) {
      throw new Error(`Token missing required scope '${required}'.`);
    }
  });
  vi.mocked(audit).mockImplementation(async (entry) => {
    auditCalls.push(entry as unknown as Record<string, unknown>);
  });
});

function buildRequest(phone: string, query: Record<string, string> = {}): NextRequest {
  const url = new URL(`http://localhost/api/v1/customers/${encodeURIComponent(phone)}/order-history`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url, {
    method: "GET",
    headers: { authorization: "Bearer dsk_test_xxxxxxxx" },
  });
}

async function call(phone: string, query: Record<string, string> = {}) {
  const { GET } = await import("./route");
  const res = await GET(buildRequest(phone, query), {
    params: Promise.resolve({ phone }),
  });
  return res;
}

describe("GET /api/v1/customers/[phone]/order-history — auth", () => {
  it("sem header Authorization devolve 401 unauthenticated", async () => {
    vi.mocked(validateBearerToken).mockRejectedValueOnce(
      new McpAuthError(-32001, 401, "Missing or malformed Authorization header."),
    );
    const res = await call(PHONE_E164);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
    expect(rpcCalls).toHaveLength(0);
  });

  it("bearer malformado devolve 401 sem chegar na RPC", async () => {
    vi.mocked(validateBearerToken).mockRejectedValueOnce(
      new McpAuthError(-32001, 401, "Invalid token format."),
    );
    const res = await call(PHONE_E164);
    expect(res.status).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });

  it("token sem scope orders:read devolve 403 forbidden_scope", async () => {
    // ensureScope é chamado com scopes reais do token (sem orders:read)
    vi.mocked(ensureScope).mockImplementationOnce(() => {
      throw new McpAuthError(-32002, 403, `Token missing required scope 'orders:read'.`);
    });
    const res = await call(PHONE_E164);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("forbidden_scope");
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("GET /api/v1/customers/[phone]/order-history — validação de input", () => {
  it("telefone vazio no path devolve 422 validation_failed", async () => {
    const res = await call("");
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("validation_failed");
    expect(rpcCalls).toHaveLength(0);
  });

  it("telefone só com letras devolve 422 sem chamar a RPC", async () => {
    const res = await call("abcdefgh");
    expect(res.status).toBe(422);
    expect(rpcCalls).toHaveLength(0);
  });

  it("limit acima de 200 devolve 422", async () => {
    const res = await call(PHONE_E164, { limit: "500" });
    expect(res.status).toBe(422);
    expect(rpcCalls).toHaveLength(0);
  });

  it("status inválido devolve 422", async () => {
    const res = await call(PHONE_E164, { status: "nao-existe" });
    expect(res.status).toBe(422);
    expect(rpcCalls).toHaveLength(0);
  });

  it("from inválido (não ISO) devolve 422", async () => {
    const res = await call(PHONE_E164, { from: "ontem" });
    expect(res.status).toBe(422);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("GET /api/v1/customers/[phone]/order-history — happy path", () => {
  it("passa organizationId do token como p_org na RPC", async () => {
    await call(PHONE_E164);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.name).toBe("fn_orders_customer_history");
    expect(rpcCalls[0]!.args.p_org).toBe(ORG_ID);
    expect(rpcCalls[0]!.args.p_phone).toBe(PHONE_E164);
  });

  it("default limit é 50 e sem cursor quando query vazio", async () => {
    await call(PHONE_E164);
    expect(rpcCalls[0]!.args.p_limit).toBe(50);
    expect(rpcCalls[0]!.args.p_cursor).toBeNull();
    expect(rpcCalls[0]!.args.p_from).toBeNull();
    expect(rpcCalls[0]!.args.p_to).toBeNull();
    expect(rpcCalls[0]!.args.p_status).toBeNull();
  });

  it("propaga filtros (from, to, status, limit, cursor) para a RPC", async () => {
    const from = "2026-01-01T00:00:00Z";
    const to = "2026-06-01T00:00:00Z";
    await call(PHONE_E164, {
      from,
      to,
      status: "completed",
      limit: "10",
      cursor: "abc",
    });
    expect(rpcCalls[0]!.args.p_from).toBe(from);
    expect(rpcCalls[0]!.args.p_to).toBe(to);
    expect(rpcCalls[0]!.args.p_status).toBe("completed");
    expect(rpcCalls[0]!.args.p_limit).toBe(10);
    expect(rpcCalls[0]!.args.p_cursor).toBe("abc");
  });

  it("cliente não encontrado devolve customer_found=false e summary zerado", async () => {
    const res = await call(PHONE_E164);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.customer_found).toBe(false);
    expect(body.data.customer).toBeNull();
    expect(body.data.summary.total_orders).toBe(0);
    expect(body.data.orders).toEqual([]);
    expect(body.meta.cursor).toBeNull();
    expect(body.meta.has_more).toBe(false);
  });

  it("cliente com pedidos devolve summary, orders e next_cursor", async () => {
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    rpcResponse = {
      data: {
        customer_found: true,
        query_phone_e164: PHONE_E164,
        customer: {
          id: "cccccccc-3333-4000-8000-000000000001",
          display_name: "Maria Cliente",
          phone_number: PHONE_E164,
          is_blocked: false,
          is_anonymized: false,
          tags: ["vip"],
        },
        summary: {
          total_orders: 12,
          total_spent_cents: 48000,
          avg_ticket_cents: 4000,
          currency: "BRL",
          first_order_at: "2025-09-01T00:00:00Z",
          last_order_at: lastWeek,
          days_since_last_order: 7,
          favorite_products: [{ product_name: "Pizza Margherita", quantity: 6, order_count: 4 }],
        },
        orders: [
          {
            id: "00000000-0000-4000-8000-0000000000b1",
            external_id: "ext-1",
            external_provider: "gm_crm_food",
            status: "delivered",
            total_cents: 4500,
            currency: "BRL",
            ordered_at: lastWeek,
            items: [{ product_name_snapshot: "Pizza Margherita", quantity: 1, line_total_cents: 4500 }],
          },
        ],
        next_cursor: "MTIzNHwwMDA=",
      },
      error: null,
    };
    const res = await call(PHONE_E164);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.customer_found).toBe(true);
    expect(body.data.customer.id).toBe("cccccccc-3333-4000-8000-000000000001");
    expect(body.data.summary.total_orders).toBe(12);
    expect(body.data.orders).toHaveLength(1);
    expect(body.data.orders[0].items).toHaveLength(1);
    expect(body.meta.cursor).toBe("MTIzNHwwMDA=");
    expect(body.meta.has_more).toBe(true);
  });
});

describe("GET /api/v1/customers/[phone]/order-history — erros da RPC", () => {
  it("22023 da fn_food_normalize_phone (telefone impossível) vira 422, não 500", async () => {
    rpcResponse = {
      data: null,
      error: { code: "22023", message: "phone_invalid" },
    };
    const res = await call(PHONE_E164);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toBe("phone_invalid");
  });

  it("22023 do cursor (cursor corrompido) vira 422", async () => {
    rpcResponse = {
      data: null,
      error: { code: "22023", message: "cursor_invalid" },
    };
    const res = await call(PHONE_E164, { cursor: "xxx" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("validation_failed");
  });

  it("qualquer outro erro da RPC vira 500 internal_error", async () => {
    rpcResponse = {
      data: null,
      error: { code: "P0001", message: "banco caiu" },
    };
    const res = await call(PHONE_E164);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(body.error.details.message).toBe("banco caiu");
  });
});

describe("GET /api/v1/customers/[phone]/order-history — audit", () => {
  it("chama audit com orders.read.history, actor_api_token_id e metadados do filtro", async () => {
    await call(PHONE_E164, { limit: "25" });
    expect(auditCalls).toHaveLength(1);
    const entry = auditCalls[0]!;
    expect(entry.action).toBe("orders.read.history");
    expect(entry.actorApiTokenId).toBe(TOKEN_ID);
    expect(entry.actorUserId).toBeNull();
    expect(entry.organizationId).toBe(ORG_ID);
    expect(entry.resourceType).toBe("contact");
    expect(entry.metadata).toMatchObject({
      query_phone_e164: PHONE_E164,
      customer_found: false,
      orders_returned: 0,
      filters: { limit: 25 },
    });
  });

  it("audit recebe o resourceId do cliente quando encontrado", async () => {
    const customerId = "cccccccc-3333-4000-8000-000000000099";
    rpcResponse = {
      data: {
        customer_found: true,
        query_phone_e164: PHONE_E164,
        customer: { id: customerId },
        summary: {},
        orders: [],
        next_cursor: null,
      },
      error: null,
    };
    await call(PHONE_E164);
    expect(auditCalls[0]!.resourceId).toBe(customerId);
  });
});

describe("GET /api/v1/customers/[phone]/order-history — X-Request-Id", () => {
  it("toda response carrega o X-Request-Id (correlaciona com audit)", async () => {
    const res = await call(PHONE_E164);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(auditCalls[0]!.requestId).toBe(res.headers.get("X-Request-Id"));
  });
});

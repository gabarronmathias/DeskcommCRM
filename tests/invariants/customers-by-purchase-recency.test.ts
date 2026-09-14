/**
 * Cobertura contra Postgres real de `fn_customers_by_purchase_recency`
 * (EPIC-21 Athos PARTE 3).
 *
 * O que este teste cobre (mapeado para o briefing PARTE 9 A-L):
 *   B. audiencia inactive_days=30 com 4 clientes (10d fora, 29d fora,
 *      30d dentro, 60d dentro)
 *   C. pedido cancelado NAO conta como ultima compra elegivel com filtro
 *      not_cancelled
 *   D. cliente de outro tenant NUNCA aparece
 *   E. blocked NAO aparece em audiencia elegivel
 *   F. anonymized NAO aparece
 *   G. opt-out (consent.marketing.granted_at IS NULL) NAO aparece
 *   H. cursor sem duplicar/perder registros (pagina por pagina)
 *   K. (parte) Sarah/MCP consegue: lista inactive_days via RPC direta
 *   L. historico vazio retorna estrutura valida
 *
 * Fora do escopo deste teste (cobertura fica em outra task):
 *   I/J. idempotencia de import Athos -- depende do import Athos que este
 *        PR nao implementa (so documenta o contrato -- PARTE 6).
 *   A. historico individual -- ja coberto por orders-customer-history.test.ts
 *      (0176). Reaproveitado.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const ORG_A = "a0000000-0000-4000-8000-0000000000a1";
const ORG_B = "b0000000-0000-4000-8000-0000000000b1";
const USER_A = "a1000000-0000-4000-8000-0000000000a1";
const USER_B = "b1000000-0000-4000-8000-0000000000b1";

const PHONE_E164 = "+5511999998888";
const PHONE_BLOCKED = "+5511999998001";
const PHONE_ANON = "+5511999998002";
const PHONE_OPTOUT = "+5511999998003";
const PHONE_B_TENANT = "+5511999998004";

const INACTIVE_DAYS = 30;
const P_NOW = "2026-09-11T12:00:00Z";

/** Construtor de contact_id deterministico por slot. */
function contactId(slot: number): string {
  const hex = slot.toString(16).padStart(12, "0");
  return `a2000000-0000-4000-8000-${hex}`;
}

function orderId(slot: number): string {
  const hex = slot.toString(16).padStart(12, "0");
  return `a3000000-0000-4000-8000-${hex}`;
}

function productId(slot: number): string {
  const hex = slot.toString(16).padStart(12, "0");
  return `a4000000-0000-4000-8000-${hex}`;
}

function itemId(slot: number): string {
  const hex = slot.toString(16).padStart(12, "0");
  return `a5000000-0000-4000-8000-${hex}`;
}

/** Calcula ordered_at para "N dias atras" relativo a P_NOW (formato ISO). */
function daysAgo(days: number): string {
  const ms = new Date(P_NOW).getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Semeia:
 * - org A com 5 contatos: happy, blocked, anonymized, optout, no-pedido
 * - org B com 1 contato (mesmo telefone base)
 * - pedidos em org A com recencia variada (10, 29, 30, 60 dias atras + 1 cancelado)
 */
function semear(): void {
  sql(`
    delete from public.food_order_items where organization_id in ('${ORG_A}','${ORG_B}');
    delete from public.orders          where organization_id in ('${ORG_A}','${ORG_B}');
    delete from public.contacts        where organization_id in ('${ORG_A}','${ORG_B}');
    delete from public.user_organizations where user_id in ('${USER_A}','${USER_B}');
    delete from auth.users                 where id     in ('${USER_A}','${USER_B}');
    delete from public.organizations       where id     in ('${ORG_A}','${ORG_B}');

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-rec-a', 'Inv Rec A', 'Inv Rec A'),
      ('${ORG_B}', 'inv-rec-b', 'Inv Rec B', 'Inv Rec B');
    insert into auth.users (id, email) values
      ('${USER_A}', 'a@invariant.test'),
      ('${USER_B}', 'b@invariant.test');
    insert into public.user_organizations (user_id, organization_id, role) values
      ('${USER_A}', '${ORG_A}', 'admin'),
      ('${USER_B}', '${ORG_B}', 'admin');

    -- Produtos tenant-scoped exigidos pela FK composta de food_order_items.
    insert into public.food_products (id, organization_id, name, slug, price_cents) values
      ('${productId(1)}', '${ORG_A}', 'Pizza Margherita', 'pizza-margherita', 5000),
      ('${productId(9)}', '${ORG_B}', 'Pizza Margherita', 'pizza-margherita', 5000);

    -- contatos da org A
    -- slot 1: happy path, opt-in de marketing, ultimo pedido 60 dias atras
    -- slot 2: blocked -> NAO aparece
    -- slot 3: anonymized -> NAO aparece
    -- slot 4: opt-out (consent.marketing.granted_at NULL) -> NAO aparece
    -- slot 5: happy path SEM pedido (cold lead) -> aparece SÓ se p_has_orders=false
    -- slot 6: happy path, opt-in, ultimo pedido 10 dias atras -> FORA da audiencia (ainda recente)
    -- slot 7: happy path, opt-in, ultimo pedido 29 dias atras -> FORA (ainda recente)
    -- slot 8: happy path, opt-in, ultimo pedido 30 dias atras -> DENTRO (limite)
    insert into public.contacts
      (id, organization_id, display_name, phone_number, is_blocked, is_anonymized, anonymized_at, consent)
    values
      ('${contactId(1)}', '${ORG_A}', 'Happy 60d',     '${PHONE_E164}',       false, false, null,
        '{"marketing":{"granted_at":"2026-01-01T00:00:00Z","source":"web","version":"1"}}'::jsonb),
      ('${contactId(2)}', '${ORG_A}', 'Blocked',         '${PHONE_BLOCKED}',    true,  false, null,
        '{"marketing":{"granted_at":"2026-01-01T00:00:00Z","source":"web","version":"1"}}'::jsonb),
      ('${contactId(3)}', '${ORG_A}', 'Anonymized',      '${PHONE_ANON}',       false, true, '${P_NOW}',
        '{"marketing":{"granted_at":"2026-01-01T00:00:00Z","source":"web","version":"1"}}'::jsonb),
      ('${contactId(4)}', '${ORG_A}', 'OptOut',          '${PHONE_OPTOUT}',     false, false, null,
        '{"marketing":{"granted_at":null,"source":null,"version":null}}'::jsonb),
      ('${contactId(5)}', '${ORG_A}', 'ColdLead',        '+5511888880001',      false, false, null,
        '{"marketing":{"granted_at":"2026-01-01T00:00:00Z","source":"web","version":"1"}}'::jsonb),
      ('${contactId(6)}', '${ORG_A}', 'Recent10d',       '+5511888880002',      false, false, null,
        '{"marketing":{"granted_at":"2026-01-01T00:00:00Z","source":"web","version":"1"}}'::jsonb),
      ('${contactId(7)}', '${ORG_A}', 'Recent29d',       '+5511888880003',      false, false, null,
        '{"marketing":{"granted_at":"2026-01-01T00:00:00Z","source":"web","version":"1"}}'::jsonb),
      ('${contactId(8)}', '${ORG_A}', 'Edge30d',         '+5511888880004',      false, false, null,
        '{"marketing":{"granted_at":"2026-01-01T00:00:00Z","source":"web","version":"1"}}'::jsonb);

    -- contato da org B (NAO pode aparecer em audiencia de org A)
    insert into public.contacts (id, organization_id, display_name, phone_number, consent) values
      ('${contactId(9)}', '${ORG_B}', 'Other Tenant', '${PHONE_B_TENANT}',
        '{"marketing":{"granted_at":"2026-01-01T00:00:00Z","source":"web","version":"1"}}'::jsonb);

    -- pedidos: cada slot recebe 1 pedido com total 5000 e 1 item de Pizza
    insert into public.orders
      (id, organization_id, external_id, external_provider, contact_id,
       status, total_cents, currency, ordered_at)
    values
      ('${orderId(1)}', '${ORG_A}', 'rec-1', 'gm_crm_food', '${contactId(1)}', 'delivered', 5000, 'BRL', '${daysAgo(60)}'),
      ('${orderId(2)}', '${ORG_A}', 'rec-2', 'gm_crm_food', '${contactId(2)}', 'delivered', 5000, 'BRL', '${daysAgo(60)}'),
      ('${orderId(3)}', '${ORG_A}', 'rec-3', 'gm_crm_food', '${contactId(3)}', 'delivered', 5000, 'BRL', '${daysAgo(60)}'),
      ('${orderId(4)}', '${ORG_A}', 'rec-4', 'gm_crm_food', '${contactId(4)}', 'delivered', 5000, 'BRL', '${daysAgo(60)}'),
      -- slot 5 NAO recebe pedido (cold lead)
      ('${orderId(6)}', '${ORG_A}', 'rec-6', 'gm_crm_food', '${contactId(6)}', 'delivered', 5000, 'BRL', '${daysAgo(10)}'),
      ('${orderId(7)}', '${ORG_A}', 'rec-7', 'gm_crm_food', '${contactId(7)}', 'delivered', 5000, 'BRL', '${daysAgo(29)}'),
      ('${orderId(8)}', '${ORG_A}', 'rec-8', 'gm_crm_food', '${contactId(8)}', 'delivered', 5000, 'BRL', '${daysAgo(30)}'),
      -- org B: pedido do slot 9, NAO pode aparecer em audiencia de org A
      ('${orderId(9)}', '${ORG_B}', 'rec-9', 'gm_crm_food', '${contactId(9)}', 'delivered', 5000, 'BRL', '${daysAgo(60)}');

    -- Para o teste C (cancelado nao conta): adicionar UM pedido cancelled
    -- ao slot 8 (Edge30d), depois do delivered de 30d. Resultado: o ultimo
    -- pedido ELEGIVEL do slot 8 continua sendo o de 30d (o cancelled NAO
    -- conta pra "ultima compra", mas conta pra "alguma vez comprou").
    insert into public.orders
      (id, organization_id, external_id, external_provider, contact_id,
       status, total_cents, currency, ordered_at)
    values
      ('${orderId(81)}', '${ORG_A}', 'rec-8-cancel', 'gm_crm_food', '${contactId(8)}',
        'cancelled', 1000, 'BRL', '${daysAgo(5)}');

    -- itens: 1 item Pizza por pedido entregue (slot 1..4, 6..8)
    insert into public.food_order_items
      (id, organization_id, order_id, product_id, product_name_snapshot,
       unit_price_cents, quantity, line_total_cents)
    values
      ('${itemId(1)}', '${ORG_A}', '${orderId(1)}', '${productId(1)}', 'Pizza Margherita', 5000, 1, 5000),
      ('${itemId(2)}', '${ORG_A}', '${orderId(2)}', '${productId(1)}', 'Pizza Margherita', 5000, 1, 5000),
      ('${itemId(3)}', '${ORG_A}', '${orderId(3)}', '${productId(1)}', 'Pizza Margherita', 5000, 1, 5000),
      ('${itemId(4)}', '${ORG_A}', '${orderId(4)}', '${productId(1)}', 'Pizza Margherita', 5000, 1, 5000),
      ('${itemId(6)}', '${ORG_A}', '${orderId(6)}', '${productId(1)}', 'Pizza Margherita', 5000, 1, 5000),
      ('${itemId(7)}', '${ORG_A}', '${orderId(7)}', '${productId(1)}', 'Pizza Margherita', 5000, 1, 5000),
      ('${itemId(8)}', '${ORG_A}', '${orderId(8)}', '${productId(1)}', 'Pizza Margherita', 5000, 1, 5000),
      ('${itemId(9)}', '${ORG_B}', '${orderId(9)}', '${productId(9)}', 'Pizza Margherita', 5000, 1, 5000);
  `);
}

/** Chama a RPC com p_now fixo (deterministico). */
function call(org: string, inactive_days: number, extras: Record<string, string> = {}): string {
  const args = Object.entries({
    p_org: org,
    p_inactive_days: inactive_days.toString(),
    p_now: P_NOW,
    ...extras,
  })
    .map(([k, v]) => `${k} := '${v.replace(/'/g, "''")}'`)
    .join(", ");
  return sql(`select public.fn_customers_by_purchase_recency(${args})::text;`);
}

/** Extrai campo jsonb de 1 nivel do json::text. */
function pick(jsonText: string, field: string): string | null {
  const m = new RegExp(`"${field}":\\s*(?:"([^"]*)"|(\\d+(?:\\.\\d+)?)|(true|false|null))`).exec(jsonText);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Conta quantas vezes um id aparece dentro do json::text. */
function countOccurrences(jsonText: string, id: string): number {
  const re = new RegExp(id.replace(/-/g, "-"), "g");
  return (jsonText.match(re) ?? []).length;
}

describe("fn_customers_by_purchase_recency — audiencia inactive_days=30", () => {
  beforeEach(semear);

  it("controle positivo: as fixtures existem (sem isto, isolamento = nada para vazar)", () => {
    const cntA = sql(`select count(*) from public.contacts where organization_id = '${ORG_A}'`);
    const cntB = sql(`select count(*) from public.contacts where organization_id = '${ORG_B}'`);
    expect(cntA).toBe("8"); // happy, blocked, anon, optout, coldlead, recent10, recent29, edge30
    expect(cntB).toBe("1");
  });

  it("happy 60d aparece DENTRO da audiencia (slot 1)", () => {
    const out = call(ORG_A, INACTIVE_DAYS);
    expect(out).toContain(contactId(1));
  });

  it("recent10d NAO aparece (slot 6, so 10 dias)", () => {
    const out = call(ORG_A, INACTIVE_DAYS);
    expect(out).not.toContain(contactId(6));
  });

  it("recent29d NAO aparece (slot 7, 29 dias - ainda dentro da janela)", () => {
    const out = call(ORG_A, INACTIVE_DAYS);
    expect(out).not.toContain(contactId(7));
  });

  it("edge30d aparece (slot 8, 30 dias - limite inclusive via <=)", () => {
    const out = call(ORG_A, INACTIVE_DAYS);
    expect(out).toContain(contactId(8));
  });

  it("retorna APENAS 2 candidatos: happy 60d (slot 1) + edge30d (slot 8)", () => {
    const out = call(ORG_A, INACTIVE_DAYS);
    // Os 2 ids DEVEM aparecer
    expect(countOccurrences(out, contactId(1))).toBeGreaterThanOrEqual(1);
    expect(countOccurrences(out, contactId(8))).toBeGreaterThanOrEqual(1);
    // Os 6 que NAO devem aparecer
    expect(countOccurrences(out, contactId(2))).toBe(0); // blocked
    expect(countOccurrences(out, contactId(3))).toBe(0); // anonymized
    expect(countOccurrences(out, contactId(4))).toBe(0); // opt-out
    expect(countOccurrences(out, contactId(5))).toBe(0); // cold lead
    expect(countOccurrences(out, contactId(6))).toBe(0); // 10d
    expect(countOccurrences(out, contactId(7))).toBe(0); // 29d
  });

  it("summary.inactive_days e next_cursor sao retornados", () => {
    const out = call(ORG_A, INACTIVE_DAYS);
    expect(pick(out, "inactive_days")).toBe("30");
    expect(pick(out, "has_orders")).toBe("true");
    expect(new Date(pick(out, "queried_at")!).toISOString()).toBe(new Date(P_NOW).toISOString());
    // next_cursor pode ser null (so 2 candidatos) ou string (mais paginas)
    const cursor = pick(out, "next_cursor");
    expect(cursor === "null" || (cursor && cursor.length > 0)).toBe(true);
  });
});

describe("fn_customers_by_purchase_recency — LGPD (PARTE 7 do briefing)", () => {
  beforeEach(semear);

  it("E. blocked NAO aparece", () => {
    expect(call(ORG_A, INACTIVE_DAYS)).not.toContain(contactId(2));
  });

  it("F. anonymized NAO aparece", () => {
    expect(call(ORG_A, INACTIVE_DAYS)).not.toContain(contactId(3));
  });

  it("G. opt-out (consent.marketing.granted_at NULL) NAO aparece", () => {
    expect(call(ORG_A, INACTIVE_DAYS)).not.toContain(contactId(4));
  });

  it("consent = {} tambem e tratado como opt-out (jsonb ->> retorna NULL em path ausente)", () => {
    // Sobe um contato com consent = '{}' explicitamente, opt-in falso.
    sql(`
      insert into public.contacts (id, organization_id, display_name, phone_number, consent)
      values ('${contactId(99)}', '${ORG_A}', 'EmptyConsent', '+5511888880099', '{}'::jsonb);
      insert into public.orders
        (id, organization_id, external_id, external_provider, contact_id,
         status, total_cents, currency, ordered_at)
      values ('${orderId(99)}', '${ORG_A}', 'rec-99', 'gm_crm_food', '${contactId(99)}',
        'delivered', 5000, 'BRL', '${daysAgo(60)}');
    `);
    expect(call(ORG_A, INACTIVE_DAYS)).not.toContain(contactId(99));
  });

  it("candidato retornado tem flag has_marketing_consent=true (para o agente decidir copy)", () => {
    const out = call(ORG_A, INACTIVE_DAYS);
    // Quando o contato aparece, deve ter a flag = true
    expect(out).toMatch(/"has_marketing_consent":\s*true/);
  });
});

describe("fn_customers_by_purchase_recency — isolamento multi-tenant (PARTE 7)", () => {
  beforeEach(semear);

  it("D. contato de OUTRO tenant NUNCA aparece (mesmo telefone nao conta)", () => {
    const out = call(ORG_A, INACTIVE_DAYS);
    expect(out).not.toContain(contactId(9));
    expect(out).not.toContain(orderId(9));
  });

  it("audiencia de org B ve apenas candidatos da org B", () => {
    // Sobe mais um contato da org B para ter o que aparecer
    sql(`
      insert into public.contacts (id, organization_id, display_name, phone_number, consent) values
        ('${contactId(91)}', '${ORG_B}', 'Org B Candidate', '+5511888880091',
          '{"marketing":{"granted_at":"2026-01-01T00:00:00Z","source":"web","version":"1"}}'::jsonb);
      insert into public.orders
        (id, organization_id, external_id, external_provider, contact_id,
         status, total_cents, currency, ordered_at)
      values ('${orderId(91)}', '${ORG_B}', 'rec-91', 'gm_crm_food', '${contactId(91)}',
        'delivered', 5000, 'BRL', '${daysAgo(60)}');
    `);
    const out = call(ORG_B, INACTIVE_DAYS);
    expect(out).toContain(contactId(91));
    // E NUNCA os candidatos da org A
    expect(out).not.toContain(contactId(1));
    expect(out).not.toContain(contactId(8));
  });
});

describe("fn_customers_by_purchase_recency — filtro por status (cancelado nao conta como ultima)", () => {
  beforeEach(semear);

  it("C. pedido cancelado NAO conta como ultima compra elegivel (filtro default not_cancelled)", () => {
    // Slot 8 (Edge30d) tem um delivered em daysAgo(30) e um cancelled em
    // daysAgo(5). O cancelled eh MAIS recente, mas NAO conta para "ultima
    // compra elegivel". A RPC tem que retornar Edge30d com last_order_at =
    // daysAgo(30) (nao daysAgo(5)).
    const out = call(ORG_A, INACTIVE_DAYS);
    // O slot 8 aparece. Procurar a janela temporal do last_order dele.
    // daysAgo(30) = 2026-08-12T12:00:00Z
    // daysAgo(5) = 2026-09-06T12:00:00Z
    expect(out).toContain("2026-08-12T12:00:00+00");
    expect(out).not.toContain("2026-09-06T12:00:00+00");
  });

  it("com p_status='cancelled' a regra inverte: contato SEM cancelled vira cold lead para esta janela", () => {
    // O slot 6 (Recent10d) tem pedido delivered. Nao tem cancelled.
    // Com p_status='cancelled' a RPC busca ULTIMO pedido CANCELADO; como slot 6
    // nao tem cancelled, fica null = cold lead = NAO aparece (p_has_orders=true).
    const out = call(ORG_A, INACTIVE_DAYS, { p_status: "cancelled" });
    expect(out).not.toContain(contactId(6));
    // Slot 8 TEM cancelled (daysAgo 5), mas p_status='cancelled' muda o threshold:
    // a janela eh "ultimo cancelled <= now - 30d" e ele eh daysAgo(5) = RECENTE.
    // Logo slot 8 NAO aparece (ultimo cancelled eh recente, nao antigo).
    expect(out).not.toContain(contactId(8));
  });
});

describe("fn_customers_by_purchase_recency — has_orders cold lead (PARTE 3)", () => {
  beforeEach(semear);

  it("p_has_orders=true (default): slot 5 (cold lead sem pedido) NAO aparece", () => {
    expect(call(ORG_A, INACTIVE_DAYS)).not.toContain(contactId(5));
  });

  it("p_has_orders=false: slot 5 (cold lead) aparece, slots com pedido NAO", () => {
    const out = call(ORG_A, INACTIVE_DAYS, { p_has_orders: "false" });
    expect(out).toContain(contactId(5));
    expect(out).not.toContain(contactId(1));
    expect(out).not.toContain(contactId(8));
  });

  it("p_has_orders=false ainda aplica LGPD: cold lead blocked/anonymized/optout NAO aparecem", () => {
    const out = call(ORG_A, INACTIVE_DAYS, { p_has_orders: "false" });
    expect(out).not.toContain(contactId(2)); // blocked
    expect(out).not.toContain(contactId(3)); // anonymized
    expect(out).not.toContain(contactId(4)); // opt-out
    // Mas o cold lead normal aparece
    expect(out).toContain(contactId(5));
  });
});

describe("fn_customers_by_purchase_recency — agregados min_orders / min_spent_cents", () => {
  beforeEach(semear);

  it("min_orders=2 sem nenhum candidato (todos tem 1 pedido) -> retorna vazio", () => {
    const out = call(ORG_A, INACTIVE_DAYS, { p_min_orders: "2" });
    // Happy 60d (slot 1) tem 1 pedido entregue; edge30d (slot 8) tem 1
    // delivered + 1 cancelled = 1 elegivel. Nenhum atinge min_orders=2.
    expect(out).not.toContain(contactId(1));
    expect(out).not.toContain(contactId(8));
  });

  it("min_orders=1 e p_has_orders=false: slot 5 (cold lead, 0 pedidos) NAO aparece (0 < 1)", () => {
    const out = call(ORG_A, INACTIVE_DAYS, {
      p_min_orders: "1",
      p_has_orders: "false",
    });
    // Cold lead tem 0 pedidos, min_orders=1, falha.
    expect(out).not.toContain(contactId(5));
  });

  it("min_spent_cents=10000: ninguem atinge (todos tem 5000 cents) -> vazio", () => {
    const out = call(ORG_A, INACTIVE_DAYS, { p_min_spent_cents: "10000" });
    expect(out).not.toContain(contactId(1));
    expect(out).not.toContain(contactId(8));
  });
});

describe("fn_customers_by_purchase_recency — paginacao cursor (PARTE 8)", () => {
  beforeEach(semear);

  it("H. com limit=1, retorna 1 candidato e next_cursor != null", () => {
    // 2 candidatos (slot 1 + slot 8). limit=1 -> pagina 1 tem 1, next_cursor != null.
    const out = call(ORG_A, INACTIVE_DAYS, { p_limit: "1" });
    const cursor = pick(out, "next_cursor");
    expect(cursor).not.toBe("null");
    expect(cursor).toBeTruthy();
  });

  it("segunda pagina continua de onde a primeira parou (sem repetir, sem pular)", () => {
    const p1 = call(ORG_A, INACTIVE_DAYS, { p_limit: "1" });
    const cursor = pick(p1, "next_cursor");
    expect(cursor).toBeTruthy();
    const p2 = call(ORG_A, INACTIVE_DAYS, { p_limit: "1", p_cursor: cursor! });
    // p1 contem slot 1 (mais recente) e p2 contem slot 8 (proximo)
    expect(p1).toContain(contactId(1));
    expect(p2).not.toContain(contactId(1));
    expect(p2).toContain(contactId(8));
  });

  it("ultima pagina tem next_cursor=null", () => {
    const out = call(ORG_A, INACTIVE_DAYS, { p_limit: "10" });
    expect(pick(out, "next_cursor")).toBe("null");
  });

  it("cursor malformado levanta cursor_invalid (22023)", () => {
    let err = "";
    try {
      sql(`select public.fn_customers_by_purchase_recency(
        p_org := '${ORG_A}', p_inactive_days := 30, p_cursor := 'lixo'
      );`);
    } catch (e) {
      err = (e instanceof Error ? e.message : String(e));
    }
    expect(err).toMatch(/cursor_invalid/i);
  });
});

describe("fn_customers_by_purchase_recency — bordas e validacao", () => {
  beforeEach(semear);

  it("L. org sem nenhum contato retorna lista vazia + estrutura valida", () => {
    sql(`delete from public.orders where organization_id = '${ORG_B}'`);
    sql(`delete from public.contacts where organization_id = '${ORG_B}'`);
    const out = call(ORG_B, INACTIVE_DAYS);
    expect(Array.isArray(JSON.parse(out).candidates)).toBe(true);
    expect(pick(out, "next_cursor")).toBe("null");
    expect(pick(out, "inactive_days")).toBe("30");
    expect(new Date(pick(out, "queried_at")!).toISOString()).toBe(new Date(P_NOW).toISOString());
  });

  it("inactive_days negativo levanta inactive_days_out_of_range (22023)", () => {
    let err = "";
    try {
      sql(`select public.fn_customers_by_purchase_recency(
        p_org := '${ORG_A}', p_inactive_days := -1
      );`);
    } catch (e) {
      err = (e instanceof Error ? e.message : String(e));
    }
    expect(err).toMatch(/inactive_days_out_of_range/i);
  });

  it("inactive_days acima de 3650 levanta inactive_days_out_of_range", () => {
    let err = "";
    try {
      sql(`select public.fn_customers_by_purchase_recency(
        p_org := '${ORG_A}', p_inactive_days := 4000
      );`);
    } catch (e) {
      err = (e instanceof Error ? e.message : String(e));
    }
    expect(err).toMatch(/inactive_days_out_of_range/i);
  });

  it("ACL: anon NAO tem EXECUTE (issue #128)", () => {
    const out = sql(`
      select has_function_privilege(
        'anon',
        'public.fn_customers_by_purchase_recency(uuid, int, int, bigint, text, int, text, boolean, timestamptz)',
        'EXECUTE'
      ) as tem;
    `);
    expect(out).toBe("f");
  });
});

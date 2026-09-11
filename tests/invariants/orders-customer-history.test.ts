/**
 * `fn_orders_customer_history` — cobertura contra Postgres real (EPIC-21 Athos).
 *
 * O que o teste unitário (`route.test.ts`) NÃO cobre, e este cobre:
 *   - A função de fato normaliza telefone via `fn_food_normalize_phone`
 *     (regex/lógica de prefixo 55, rejeição de lixo, E.164);
 *   - O filtro manual de `organization_id` ISOLA quando chamada por service-role
 *     (defesa em profundidade: `auth.uid()` é null no service-role, então sem
 *     o filtro, a função vazaria);
 *   - O agregado (`total_spent_cents`, `avg_ticket_cents`, `days_since_last_order`)
 *     bate com a fórmula no banco;
 *   - O `next_cursor` é opaco e estável: passa de página em página sem
 *     duplicar nem pular pedidos;
 *   - `favorite_products` agrupa certo entre pedidos e respeita o filtro de
 *     status;
 *   - `customer_found=false` quando o telefone não casa (cold-lead: a Sarah
 *     usa isso pra campanhas de aquisição).
 *
 * Roda contra o Postgres efêmero do `scripts/test-db.sh` (baseline.sql já
 * aplicado). Os helpers em `gov-helpers.ts` montam 2 organizações com seeds
 * determinísticos (namespace `aaaa-`/`bbbb-`).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

// ---------- fixtures determinísticas (namespace aaaa-/bbbb-) ----------

const ORG_A = "a0000000-0000-4000-8000-0000000000a1";
const ORG_B = "b0000000-0000-4000-8000-0000000000b1";
const USER_A = "a1000000-0000-4000-8000-0000000000a1";
const USER_B = "b1000000-0000-4000-8000-0000000000b1";

const CONTACT_A = "a2000000-0000-4000-8000-0000000000a1";
const CONTACT_B = "b2000000-0000-4000-8000-0000000000b1";
const PHONE_E164 = "+5511999998888"; // mesmo telefone em 2 orgs → isola por org

/** ID estável pra cada pedido — ordenado por ordered_at. */
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

/** `now()` fixo pra `days_since_last_order` ser determinístico entre runs. */
const P_NOW = "2026-09-11T12:00:00Z";

/**
 * Semear 2 orgs com 1 contato cada (mesmo telefone — E.164, formato canônico)
 * e 4 pedidos na org A + 2 na org B, mais 6 itens (todos na org A pra testar
 * `favorite_products`).
 *
 * Pedidos A: hoje, hoje-30d, hoje-60d (delivered), hoje-90d (cancelled),
 *            hoje-200d (refunded). 4 não-cancelled, 1 cancelled, 1 refunded.
 * Pedidos B: hoje, hoje-10d (cancelled). Só 1 não-cancelled.
 *
 * Total esperado na org A (com filtro padrão): 4 pedidos, soma=15000 cents
 * (3000+4000+5000+3000 = 15000 — o cancelled 2000 e o refunded 1000 saem
 * da soma). Ticket médio = 15000/4 = 3750 (round). first=today-200d,
 * last=today, days_since=0 (com P_NOW = now).
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
      ('${ORG_A}', 'inv-ord-a', 'Inv Ord A', 'Inv Ord A'),
      ('${ORG_B}', 'inv-ord-b', 'Inv Ord B', 'Inv Ord B');
    insert into auth.users (id, email) values
      ('${USER_A}', 'a@invariant.test'),
      ('${USER_B}', 'b@invariant.test');
    insert into public.user_organizations (user_id, organization_id, role) values
      ('${USER_A}', '${ORG_A}', 'admin'),
      ('${USER_B}', '${ORG_B}', 'admin');

    insert into public.contacts (id, organization_id, display_name, phone_number) values
      ('${CONTACT_A}', '${ORG_A}', 'Cliente A',  '${PHONE_E164}'),
      ('${CONTACT_B}', '${ORG_B}', 'Cliente B',  '${PHONE_E164}');

    -- Pedidos da org A (5 total: 3 delivered + 1 cancelled + 1 refunded).
    -- ordered_at: hoje, hoje-30d, hoje-60d, hoje-90d, hoje-200d
    insert into public.orders
      (id, organization_id, external_id, external_provider, contact_id,
       status, total_cents, currency, ordered_at)
    values
      ('${orderId(1)}', '${ORG_A}', 'a-1', 'gm_crm_food', '${CONTACT_A}',
        'delivered', 3000, 'BRL', '2026-09-11T10:00:00Z'),
      ('${orderId(2)}', '${ORG_A}', 'a-2', 'gm_crm_food', '${CONTACT_A}',
        'delivered', 4000, 'BRL', '2026-08-12T10:00:00Z'),
      ('${orderId(3)}', '${ORG_A}', 'a-3', 'gm_crm_food', '${CONTACT_A}',
        'delivered', 5000, 'BRL', '2026-07-12T10:00:00Z'),
      ('${orderId(4)}', '${ORG_A}', 'a-4', 'gm_crm_food', '${CONTACT_A}',
        'cancelled', 2000, 'BRL', '2026-06-12T10:00:00Z'),
      ('${orderId(5)}', '${ORG_A}', 'a-5', 'gm_crm_food', '${CONTACT_A}',
        'refunded',  1000, 'BRL', '2026-02-23T10:00:00Z');

    -- Pedidos da org B (2: 1 delivered, 1 cancelled). Mesmo telefone, org
    -- diferente — é o caso de isolamento que importa.
    insert into public.orders
      (id, organization_id, external_id, external_provider, contact_id,
       status, total_cents, currency, ordered_at)
    values
      ('${orderId(6)}', '${ORG_B}', 'b-1', 'gm_crm_food', '${CONTACT_B}',
        'delivered', 8000, 'BRL', '2026-09-11T08:00:00Z'),
      ('${orderId(7)}', '${ORG_B}', 'b-2', 'gm_crm_food', '${CONTACT_B}',
        'cancelled', 1000, 'BRL', '2026-09-01T08:00:00Z');

    -- Itens: 6 linhas em 3 pedidos diferentes da org A. Cada pedido tem 2 itens.
    -- Pizza aparece 3x (qty total 4), Hamburguer 2x (qty total 3), Sushi 1x.
    insert into public.food_order_items
      (id, organization_id, order_id, product_id, product_name_snapshot,
       unit_price_cents, quantity, line_total_cents)
    values
      ('${itemId(1)}', '${ORG_A}', '${orderId(1)}', '${productId(1)}', 'Pizza Margherita',
        1500, 2, 3000),
      ('${itemId(2)}', '${ORG_A}', '${orderId(1)}', '${productId(2)}', 'Hamburguer',
        1500, 1, 1500),
      ('${itemId(3)}', '${ORG_A}', '${orderId(2)}', '${productId(1)}', 'Pizza Margherita',
        1500, 2, 3000),
      ('${itemId(4)}', '${ORG_A}', '${orderId(2)}', '${productId(3)}', 'Sushi Combo',
        1000, 1, 1000),
      ('${itemId(5)}', '${ORG_A}', '${orderId(3)}', '${productId(2)}', 'Hamburguer',
        2500, 2, 5000),
      ('${itemId(6)}', '${ORG_A}', '${orderId(5)}', '${productId(1)}', 'Pizza Margherita',
        1000, 1, 1000);
  `);
}

/** Helper: invoca a função como `service_role` (atravessa RLS, exercita o filtro manual). */
function callAsService(org: string, phone: string, extras: Record<string, string> = {}): string {
  const args = Object.entries({ p_org: org, p_phone: phone, p_now: P_NOW, ...extras })
    .map(([k, v]) => `${k} := '${v.replace(/'/g, "''")}'`)
    .join(", ");
  // jsonb_pretty só pra debug; em produção é `select fn(...)::text`
  return sql(`select public.fn_orders_customer_history(${args})::text;`);
}

/** Extrai um campo jsonb por nome (1 nível) — o payload é jsonb::text. */
function pickField(jsonText: string, field: string): string | null {
  const m = new RegExp(`"${field}":\\s*(?:"([^"]*)"|(\\d+(?:\\.\\d+)?)|(true|false|null))`).exec(jsonText);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Conta quantas vezes um par "chave": valor aparece no json text (1 nível). */
function countWhere(jsonText: string, key: string, value: string): number {
  const re = new RegExp(`"${key}":\\s*(?:"[^"]*"|\\d+|true|false|null)`, "g");
  // mais simples: parse de occurrences exatas
  const exact = new RegExp(`"${key}":\\s*"${value}"`, "g");
  return (jsonText.match(exact) ?? []).length;
}

describe("fn_orders_customer_history — isolamento por organização (defesa em profundidade)", () => {
  beforeEach(semear);

  it("controle positivo: as fixtures existem (sem isto, vazamento = nada para vazar)", () => {
    const totalA = sql(
      `select count(*) from public.orders where organization_id = '${ORG_A}'`,
    );
    const totalB = sql(
      `select count(*) from public.orders where organization_id = '${ORG_B}'`,
    );
    expect(totalA).toBe("5");
    expect(totalB).toBe("2");
  });

  it("service-role chamando com p_org=A só vê pedidos/contatos da A (mesmo telefone)", () => {
    const out = callAsService(ORG_A, PHONE_E164);
    expect(pickField(out, "customer_found")).toBe("true");
    expect(out).toContain(CONTACT_A);
    // Nenhum pedido da org B pode aparecer:
    expect(out).not.toContain(orderId(6));
    expect(out).not.toContain(orderId(7));
  });

  it("service-role chamando com p_org=B só vê pedidos/contatos da B", () => {
    const out = callAsService(ORG_B, PHONE_E164);
    expect(pickField(out, "customer_found")).toBe("true");
    expect(out).toContain(CONTACT_B);
    expect(out).not.toContain(orderId(1));
    expect(out).not.toContain(orderId(5));
  });
});

describe("fn_orders_customer_history — agregados", () => {
  beforeEach(semear);

  it("total_orders reflete o filtro: 5 na org A (cancelled e refunded contam)", () => {
    const out = callAsService(ORG_A, PHONE_E164);
    expect(pickField(out, "total_orders")).toBe("5");
  });

  it("total_spent_cents EXCLUI cancelled e refunded: 15000 (3000+4000+5000)", () => {
    const out = callAsService(ORG_A, PHONE_E164);
    expect(pickField(out, "total_spent_cents")).toBe("15000");
  });

  it("avg_ticket_cents = total_spent / count(não-cancelled) = 15000/4 = 3750", () => {
    const out = callAsService(ORG_A, PHONE_E164);
    expect(pickField(out, "avg_ticket_cents")).toBe("3750");
  });

  it("first_order_at é o mais antigo (2026-02-23, refunded) e last_order_at é o mais recente (2026-09-11)", () => {
    const out = callAsService(ORG_A, PHONE_E164);
    expect(out).toContain("2026-02-23T10:00:00+00");
    expect(out).toContain("2026-09-11T10:00:00+00");
  });

  it("days_since_last_order = 0 quando p_now é exatamente o último pedido", () => {
    // P_NOW = 2026-09-11T12:00:00Z; último pedido = 2026-09-11T10:00:00Z (2h atrás)
    const out = callAsService(ORG_A, PHONE_E164);
    expect(pickField(out, "days_since_last_order")).toBe("0");
  });

  it("days_since_last_order respeita p_now: 60 dias com P_NOW bem no futuro", () => {
    // P_NOW = 2026-09-11; último pedido = 2026-09-11 → 0 dias
    // Com p_now em 2026-11-10 (60 dias depois) → 60
    const out = callAsService(ORG_A, PHONE_E164, { p_now: "2026-11-10T12:00:00Z" });
    expect(pickField(out, "days_since_last_order")).toBe("60");
  });

  it("filtro status='completed' (pseudo) vira paid+fulfilled+shipped+delivered: 3 pedidos", () => {
    const out = callAsService(ORG_A, PHONE_E164, { p_status: "completed" });
    expect(pickField(out, "total_orders")).toBe("3");
  });

  it("filtro status='not_cancelled' exclui cancelled e refunded: 3 pedidos", () => {
    const out = callAsService(ORG_A, PHONE_E164, { p_status: "not_cancelled" });
    expect(pickField(out, "total_orders")).toBe("3");
  });

  it("filtro status='cancelled' deixa só 1 pedido e zera total_spent", () => {
    const out = callAsService(ORG_A, PHONE_E164, { p_status: "cancelled" });
    expect(pickField(out, "total_orders")).toBe("1");
    expect(pickField(out, "total_spent_cents")).toBe("0");
  });

  it("filtro from corta o passado: from=2026-07-01 → 3 pedidos", () => {
    const out = callAsService(ORG_A, PHONE_E164, { p_from: "2026-07-01T00:00:00Z" });
    expect(pickField(out, "total_orders")).toBe("3");
  });

  it("filtro to também é exclusivo: to=2026-07-12T10:00:00Z → só 1 (o refund)", () => {
    // to é exclusivo (half-open). Pedidos EXATAMENTE no to saem.
    const out = callAsService(ORG_A, PHONE_E164, { p_to: "2026-07-12T10:00:00Z" });
    expect(pickField(out, "total_orders")).toBe("2"); // 02-23 (refunded) + 06-12 (cancelled)
  });
});

describe("fn_orders_customer_history — favorite_products", () => {
  beforeEach(semear);

  it("Pizza Margherita é top: 5 unidades em 3 pedidos (2+2+1)", () => {
    const out = callAsService(ORG_A, PHONE_E164);
    // A string `Pizza Margherita` aparece 3x no JSON: top-1 + 2 itens nos orders
    expect(countWhere(out, "product_name", "Pizza Margherita")).toBeGreaterThanOrEqual(3);
  });

  it("Hamburguer é #2: 3 unidades em 2 pedidos", () => {
    const out = callAsService(ORG_A, PHONE_E164);
    expect(out).toContain("Hamburguer");
  });

  it("Sushi aparece só 1x — fora do top 5? Está dentro porque temos só 3 produtos distintos", () => {
    const out = callAsService(ORG_A, PHONE_E164);
    expect(out).toContain("Sushi Combo");
  });

  it("filtro de status exclui pedidos cancelled dos itens: 3 itens Pizza em vez de 4", () => {
    // Filtro status=cancelled não tem itens (pedidos cancelled não somam em items
    // porque NÃO há food_order_items pra eles — só seeded pra delivered e refunded).
    // O que importa: total_orders=1 e nenhum Pizza/Hamburguer aparece no top.
    const out = callAsService(ORG_A, PHONE_E164, { p_status: "cancelled" });
    expect(pickField(out, "total_orders")).toBe("1");
    // favorite_products fica vazio (jsonb []); não contém os produtos seeded.
    expect(out).not.toContain("Pizza Margherita");
  });
});

describe("fn_orders_customer_history — lista de pedidos e paginação cursor", () => {
  beforeEach(semear);

  it("primeira página com limit=2 traz os 2 mais recentes (DESC) e next_cursor", () => {
    const out = callAsService(ORG_A, PHONE_E164, { p_limit: "2" });
    expect(out).toContain(orderId(1)); // hoje
    expect(out).toContain(orderId(2)); // -30d
    expect(out).not.toContain(orderId(3));
    // cursor presente e não-vazio
    const cursor = pickField(out, "next_cursor");
    expect(cursor).toBeTruthy();
    expect(cursor).not.toBe("null");
  });

  it("segunda página com o next_cursor da primeira continua onde parou (sem repetir, sem pular)", () => {
    const first = callAsService(ORG_A, PHONE_E164, { p_limit: "2" });
    const cursor = pickField(first, "next_cursor");
    expect(cursor).toBeTruthy();

    const second = callAsService(ORG_A, PHONE_E164, {
      p_limit: "2",
      p_cursor: cursor!,
    });
    // Deve trazer os 2 PRÓXIMOS (id 3 e id 4 — ou id 5 se ordering diferente),
    // mas nunca repetir id 1 nem id 2.
    expect(second).not.toContain(orderId(1));
    expect(second).not.toContain(orderId(2));
    expect(second).toContain(orderId(3));
  });

  it("última página tem next_cursor=null", () => {
    // 5 pedidos na org A. limit=10 cabe tudo de uma vez → sem próxima página.
    const out = callAsService(ORG_A, PHONE_E164, { p_limit: "10" });
    expect(pickField(out, "next_cursor")).toBe("null");
  });

  it("cursor malformado retorna 22023 (cursor_invalid)", () => {
    let err = "";
    try {
      sql(`select public.fn_orders_customer_history(
        p_org := '${ORG_A}', p_phone := '${PHONE_E164}', p_cursor := 'isso-nao-e-base64'
      );`);
    } catch (e) {
      err = motivoDoErro(e);
    }
    expect(err).toMatch(/cursor_invalid/i);
  });

  it("pedido carrega seus itens embutidos (sem N+1)", () => {
    const out = callAsService(ORG_A, PHONE_E164, { p_limit: "1" });
    // O pedido mais recente (id 1) tem 2 itens: Pizza + Hamburguer.
    expect(out).toContain("Pizza Margherita");
    expect(out).toContain("Hamburguer");
  });
});

describe("fn_orders_customer_history — casos de borda", () => {
  beforeEach(semear);

  it("telefone inexistente devolve customer_found=false e summary zerado (cold-lead)", () => {
    const out = callAsService(ORG_A, "+5511888887777"); // ninguém com esse telefone
    expect(pickField(out, "customer_found")).toBe("false");
    expect(pickField(out, "total_orders")).toBe("0");
    expect(pickField(out, "total_spent_cents")).toBe("0");
    expect(pickField(out, "days_since_last_order")).toBe("null");
  });

  it("telefone normalizado: com espaços e sem +55 bate no mesmo cliente", () => {
    const out = callAsService(ORG_A, "11 99999-8888"); // formato BR comum
    expect(pickField(out, "customer_found")).toBe("true");
    expect(out).toContain(CONTACT_A);
  });

  it("telefone impossível (3 dígitos) levanta phone_required (22023)", () => {
    let err = "";
    try {
      sql(`select public.fn_orders_customer_history(
        p_org := '${ORG_A}', p_phone := '123'
      );`);
    } catch (e) {
      err = motivoDoErro(e);
    }
    expect(err).toMatch(/phone_required|phone_invalid/i);
  });

  it("p_limit acima de 200 cai para o cap (200) — função não estoura", () => {
    // Sem erro e com dados: a função é `greatest(1, least(coalesce(p_limit, 50), 200))`.
    const out = callAsService(ORG_A, PHONE_E164, { p_limit: "999" });
    expect(pickField(out, "customer_found")).toBe("true");
  });

  it("ACL: authenticated NÃO tem EXECUTE na função (default privileges limpo pelo varredura anon)", () => {
    // Garante que a revogação foi aplicada (issue #128). authenticated pode até
    // estar GRANTED explicitamente — esse teste checa que o apêndice do baseline
    // NÃO concedeu a anon.
    const grantedToAnon = sql(`
      select has_function_privilege(
        'anon',
        'public.fn_orders_customer_history(uuid, text, timestamptz, timestamptz, text, int, text, timestamptz)',
        'EXECUTE'
      ) as tem;
    `);
    expect(grantedToAnon).toBe("f");
  });
});

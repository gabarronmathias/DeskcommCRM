import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(process.env.TEST_DB_PORT ?? 54329)}/postgres`,
  max: 2,
});

const policy = {
  timezone: "America/Sao_Paulo",
  threshold_cents: 10_000,
  up_to_threshold_fee_cents: 1_000,
  weekday_before_cutoff_fee_cents: 500,
  weekday_from_cutoff_fee_cents: 0,
  weekend_fee_cents: 0,
  cutoff_local_time: "19:00",
  blocked_neighborhoods: ["Rio Cumprido", "Cidade Salvador"],
};
const areas = ["Jacareí"];

async function quote(subtotal: number, city: string, neighborhood: string, at: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const result = await client.query<{ quote: Record<string, unknown> }>(
      `select public.fn_food_delivery_quote($1::jsonb,$2::jsonb,$3::bigint,$4::text,$5::text,$6::timestamptz) as quote`,
      [JSON.stringify(policy), JSON.stringify(areas), subtotal, city, neighborhood, at],
    );
    await client.query("rollback");
    return result.rows[0]?.quote;
  } finally {
    client.release();
  }
}

afterAll(async () => pool.end());

describe("fn_food_delivery_quote no Postgres do produto", () => {
  it("cobra R$10 em R$100,00 inclusive", async () => {
    await expect(quote(10_000, "Jacareí", "Centro", "2026-11-27T21:59:00Z"))
      .resolves.toMatchObject({ eligible: true, fee_cents: 1_000 });
  });

  it("cobra R$5 em R$100,01 na sexta às 18:59 locais", async () => {
    await expect(quote(10_001, "Jacareí", "Centro", "2026-11-27T21:59:00Z"))
      .resolves.toMatchObject({ eligible: true, fee_cents: 500 });
  });

  it("zera às 19:00 local na sexta e durante sábado e domingo", async () => {
    await expect(quote(10_001, "Jacareí", "Centro", "2026-11-27T22:00:00Z"))
      .resolves.toMatchObject({ eligible: true, fee_cents: 0 });
    await expect(quote(10_001, "Jacareí", "Centro", "2026-11-28T15:00:00Z"))
      .resolves.toMatchObject({ eligible: true, fee_cents: 0 });
    await expect(quote(10_001, "Jacareí", "Centro", "2026-11-29T15:00:00Z"))
      .resolves.toMatchObject({ eligible: true, fee_cents: 0 });
  });

  it("bloqueia as regiões cadastradas e recusa cidade fora da cobertura", async () => {
    await expect(quote(50_000, "Jacareí", "RIO CUMPRIDO", "2026-11-27T22:00:00Z"))
      .resolves.toMatchObject({ eligible: false, fee_cents: 0, reason: "blocked_neighborhood" });
    await expect(quote(50_000, "São José dos Campos", "Centro", "2026-11-27T22:00:00Z"))
      .resolves.toMatchObject({ eligible: false, fee_cents: 0, reason: "outside_service_area" });
  });
});

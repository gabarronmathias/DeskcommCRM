import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

/**
 * A partir da 0156 o apêndice usa o nome integral da migration como marcador.
 * Assim uma migration nova não pode chegar ao Git sem chegar ao artefato que o
 * install.sh/update.sh dos self-hosters realmente aplicam.
 */
describe("migrations recentes × baseline self-host", () => {
  it("mantém no baseline toda migration desde a 0156", () => {
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((name) => /^2026\d{10}_.+\.sql$/u.test(name))
      .filter((name) => name >= "20260813120000_0156_")
      .map((name) => basename(name, ".sql"));

    expect(migrations.length).toBeGreaterThan(0);
    const missing = migrations.filter(
      (name) => !BASELINE.includes(`-- ---- ${name} ----`),
    );
    expect(
      missing,
      "migration recente sem apêndice no baseline.sql — o self-host não receberia a mudança",
    ).toEqual([]);
  });
});

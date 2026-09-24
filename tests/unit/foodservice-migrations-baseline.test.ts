import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

// One-off data corrections are intentionally not replayed by a fresh self-host
// install: their source rows do not exist in a clean database. Keep this list
// explicit so schema/behavior migrations still must be represented in baseline.
const DATA_ONLY_MIGRATIONS = new Set([
  "20260904130000_pause_480graus_revert_paizzani",
  "20260904130001_cleanup_hermes_e2e_fixtures",
  "20260909120000_external_provider_gm_crm_food",
]);

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
      .filter((name) => !DATA_ONLY_MIGRATIONS.has(basename(name, ".sql")))
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

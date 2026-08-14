import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const blueprint = readFileSync(join(__dirname, "..", "..", "render.yaml"), "utf8");

describe("Blueprint do SaaS no Render", () => {
  it("declara as tres pecas necessarias para a demonstracao permanente", () => {
    for (const service of ["gm-delivery-saas", "gm-delivery-worker", "gm-delivery-waha"]) {
      expect(blueprint).toContain(`name: ${service}`);
    }
    expect(blueprint).toContain("dockerfilePath: ./Dockerfile.worker");
    expect(blueprint).not.toContain("name: gm-delivery-scheduler");
  });

  it("mantem o WAHA privado, pinado e com sessao persistente", () => {
    expect(blueprint).toMatch(
      /type: pserv[\s\S]*name: gm-delivery-waha[\s\S]*devlikeapro\/waha:latest-2026\.7\.2/,
    );
    expect(blueprint).toContain("mountPath: /app/.sessions");
    expect(blueprint).toContain("sizeGB: 1");
    expect(blueprint).toContain("WHATSAPP_DEFAULT_ENGINE");
    expect(blueprint).toContain("value: NOWEB");
  });

  it("liga app e worker ao WAHA pela rede privada", () => {
    expect(blueprint).toMatch(/key: WAHA_API_BASE_URL[\s\S]*type: pserv[\s\S]*property: hostport/);
  });

  it("nao grava os segredos fornecidos pelo operador no Git", () => {
    for (const key of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_DB_URL",
      "UPSTASH_REDIS_REST_TOKEN",
      "WHATSAPP_HOOK_URL",
    ]) {
      const declaration = new RegExp(`key: ${key}\\n\\s+sync: false`);
      expect(blueprint).toMatch(declaration);
    }
  });
});

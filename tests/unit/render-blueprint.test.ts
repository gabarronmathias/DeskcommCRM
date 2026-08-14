import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const blueprint = readFileSync(join(__dirname, "..", "..", "render.yaml"), "utf8");

describe("Blueprint do SaaS no Render", () => {
  it("declara as tres pecas gratuitas da demonstracao sob demanda", () => {
    for (const service of [
      "gm-delivery-demo-gm",
      "gm-delivery-worker-demo-gm",
      "gm-delivery-waha-demo-gm",
    ]) {
      expect(blueprint).toContain(`name: ${service}`);
    }
    expect(blueprint.match(/plan: free/g)).toHaveLength(3);
    expect(blueprint).toContain("dockerfilePath: ./Dockerfile.worker");
    expect(blueprint).not.toContain("name: gm-delivery-scheduler");
  });

  it("mantem o WAHA pinado, protegido e efemero", () => {
    expect(blueprint).toMatch(
      /type: web[\s\S]*name: gm-delivery-waha-demo-gm[\s\S]*devlikeapro\/waha:latest-2026\.7\.2/,
    );
    expect(blueprint).not.toContain("mountPath:");
    expect(blueprint).not.toContain("sizeGB:");
    expect(blueprint).toContain("WHATSAPP_DEFAULT_ENGINE");
    expect(blueprint).toContain("value: NOWEB");
    expect(blueprint).toContain("WAHA_DASHBOARD_ENABLED");
  });

  it("liga app e worker ao WAHA HTTPS e acorda os servicos antes da demo", () => {
    expect(
      blueprint.match(/value: https:\/\/gm-delivery-waha-demo-gm\.onrender\.com/g),
    ).toHaveLength(3);
    expect(blueprint).toContain("value: https://gm-delivery-worker-demo-gm.onrender.com/healthz");
    expect(blueprint).toContain("healthCheckPath: /healthz");
  });

  it("nao grava os segredos fornecidos pelo operador no Git", () => {
    for (const key of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_DB_URL",
      "UPSTASH_REDIS_REST_TOKEN",
    ]) {
      const declaration = new RegExp(`key: ${key}\\n\\s+sync: false`);
      expect(blueprint).toMatch(declaration);
    }
    expect(blueprint).toContain(
      "value: https://gm-delivery-demo-gm.onrender.com/api/v1/webhooks/waha",
    );
  });
});

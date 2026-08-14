import { describe, expect, it } from "vitest";

import { normalizeWahaBaseUrl } from "./base-url";

describe("normalizeWahaBaseUrl", () => {
  it("preserva URLs absolutas do Docker Compose", () => {
    expect(normalizeWahaBaseUrl("http://waha:3000/")).toBe("http://waha:3000");
    expect(normalizeWahaBaseUrl("https://waha.example.com///")).toBe(
      "https://waha.example.com",
    );
  });

  it("transforma hostport do Render em URL HTTP privada", () => {
    expect(normalizeWahaBaseUrl("gm-delivery-waha:3000")).toBe(
      "http://gm-delivery-waha:3000",
    );
  });

  it("mantem ausencia como ausencia", () => {
    expect(normalizeWahaBaseUrl(undefined)).toBe("");
    expect(normalizeWahaBaseUrl("  ")).toBe("");
  });
});


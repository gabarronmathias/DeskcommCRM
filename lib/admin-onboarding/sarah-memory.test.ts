import { describe, expect, it } from "vitest";
import { buildSarahMemoryContent, isSarahMemoryPublished } from "./sarah-memory";

const settings = {
  name: "Sarah", greeting: "Olá", rules: "Sem promessas", commercial_guidance: "",
  priority_products: "", upsell_guidance: "", handoff_guidance: "",
};

describe("memória publicada da Sarah", () => {
  it("só considera pronta a mesma versão e o mesmo conteúdo", () => {
    const content = buildSarahMemoryContent(settings);
    expect(isSarahMemoryPublished(settings, "v1", "v1", content)).toBe(true);
    expect(isSarahMemoryPublished({ ...settings, rules: "Nova regra" }, "v1", "v1", content)).toBe(false);
    expect(isSarahMemoryPublished(settings, null, null, content)).toBe(false);
  });
});

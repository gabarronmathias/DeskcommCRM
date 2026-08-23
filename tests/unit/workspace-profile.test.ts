import { describe, expect, it } from "vitest";

import { isDestinationAvailable, workspaceProfileForOrganization } from "@/lib/workspace/profile";

describe("perfil comercial Foodservice", () => {
  it("aplica o perfil somente à organização de prospecção", () => {
    expect(workspaceProfileForOrganization("gabarron-mathias")).toBe("foodservice_prospecting");
    expect(workspaceProfileForOrganization("choperia-do-gordo")).toBe("standard");
  });

  it("não oferece pedidos nem Nuvemshop na operação comercial", () => {
    expect(isDestinationAvailable("/app/orders", "foodservice_prospecting")).toBe(false);
    expect(isDestinationAvailable("/app/integrations/nuvemshop", "foodservice_prospecting")).toBe(false);
    expect(isDestinationAvailable("/app/ai/agents", "foodservice_prospecting")).toBe(true);
  });
});

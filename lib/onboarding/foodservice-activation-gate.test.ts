import { describe, expect, it } from "vitest";
import { foodserviceActivationGatePending } from "./foodservice-activation-gate";

describe("foodserviceActivationGatePending", () => {
  it("does not gate organizations outside Foodservice onboarding", () => {
    expect(foodserviceActivationGatePending({ welcome: { accepted_at: "now" } })).toBe(false);
    expect(foodserviceActivationGatePending(null)).toBe(false);
  });
  it("gates Foodservice until administrative activation", () => {
    expect(foodserviceActivationGatePending({ foodservice_setup: {} })).toBe(true);
    expect(foodserviceActivationGatePending({ foodservice_setup: { status: "DRAFT" } })).toBe(true);
  });
  it("allows Foodservice after administrative activation", () => {
    expect(foodserviceActivationGatePending({ foodservice_setup: { status: "ACTIVE" } })).toBe(false);
  });
});

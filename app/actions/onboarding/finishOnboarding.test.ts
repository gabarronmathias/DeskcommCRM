import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  requireOnboardingCtx: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: mocks.from }),
}));
vi.mock("./_shared", () => ({
  requireOnboardingCtx: mocks.requireOnboardingCtx,
  OnboardingError: class OnboardingError extends Error {
    code = "db_error";
  },
}));

import { finishOnboarding } from "./finishOnboarding";

describe("finishOnboarding Foodservice gate", () => {
  const maybeSingle = vi.fn();
  const update = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOnboardingCtx.mockResolvedValue({
      userId: "user-test",
      orgId: "org-test",
      orgName: "Foodservice test",
      role: "admin",
      fullName: "Operator Test",
      email: "operator@example.test",
    });
    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle,
      update,
    };
    mocks.from.mockReturnValue(query);
    maybeSingle.mockResolvedValue({
      data: { onboarded_at: null, onboarding_state: { foodservice_setup: { status: "DRAFT" } } },
      error: null,
    });
  });

  it("does not stamp onboarded_at or emit completion while Foodservice activation is pending", async () => {
    await expect(finishOnboarding()).resolves.toEqual({
      ok: false,
      error: "foodservice_activation_required",
    });
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("organizations");
    expect(update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("fails closed if the organization state cannot be read", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "read failed" } });
    await expect(finishOnboarding()).resolves.toEqual({ ok: false, error: "db_error" });
    expect(update).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

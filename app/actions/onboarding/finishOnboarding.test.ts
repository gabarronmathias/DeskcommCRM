import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditMock, adminClientMock, requireContextMock } = vi.hoisted(() => ({
  auditMock: vi.fn(),
  adminClientMock: vi.fn(),
  requireContextMock: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: adminClientMock }));
vi.mock("./_shared", () => ({
  requireOnboardingCtx: requireContextMock,
  OnboardingError: class OnboardingError extends Error { code = "db_error"; },
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { finishOnboarding } from "./finishOnboarding";

describe("finishOnboarding Foodservice gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireContextMock.mockResolvedValue({ orgId: "tenant-a", userId: "user-a" });
  });

  it("não define onboarded_at nem publica evento antes da ativação Foodservice", async () => {
    const update = vi.fn();
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { onboarded_at: null, onboarding_state: { foodservice_setup: { status: "DRAFT" } } },
      error: null,
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    adminClientMock.mockReturnValue({ from: vi.fn(() => ({ select, update })) });

    await expect(finishOnboarding()).resolves.toEqual({ ok: false, error: "foodservice_activation_required" });
    expect(update).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("falha fechado quando não consegue ler a organização", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: "read failed" } });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    adminClientMock.mockReturnValue({ from: vi.fn(() => ({ select })) });

    await expect(finishOnboarding()).resolves.toMatchObject({ ok: false, error: "db_error" });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

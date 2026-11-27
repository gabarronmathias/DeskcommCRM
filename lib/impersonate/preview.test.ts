import { describe, expect, it } from "vitest";
import {
  IMPERSONATE_END_PATH,
  READ_ONLY_PREVIEW_MODE,
  isAdminPreviewForTenant,
  shouldBlockReadOnlyPreviewMutation,
} from "./preview";

const payload = {
  tenantId: "tenant-a",
  platformAdminId: "admin-a",
  exp: 2_000_000_000,
  mode: READ_ONLY_PREVIEW_MODE,
} as const;

describe("preview administrativo de tenant incompleto", () => {
  it("só abre o gate para o platform admin dono do cookie e tenant correspondente", () => {
    expect(
      isAdminPreviewForTenant({
        isPlatformAdmin: true,
        authUserId: "admin-a",
        activeOrgId: "tenant-a",
        onboardedAt: null,
        payload,
      }),
    ).toBe(true);

    expect(
      isAdminPreviewForTenant({
        isPlatformAdmin: false,
        authUserId: "admin-a",
        activeOrgId: "tenant-a",
        onboardedAt: null,
        payload,
      }),
    ).toBe(false);
    expect(
      isAdminPreviewForTenant({
        isPlatformAdmin: true,
        authUserId: "another-admin",
        activeOrgId: "tenant-a",
        onboardedAt: null,
        payload,
      }),
    ).toBe(false);
    expect(
      isAdminPreviewForTenant({
        isPlatformAdmin: true,
        authUserId: "admin-a",
        activeOrgId: "tenant-b",
        onboardedAt: null,
        payload,
      }),
    ).toBe(false);
    expect(
      isAdminPreviewForTenant({
        isPlatformAdmin: true,
        authUserId: "admin-a",
        activeOrgId: "tenant-a",
        onboardedAt: "2026-11-26T00:00:00.000Z",
        payload,
      }),
    ).toBe(false);
  });

  it("bloqueia mutações em rotas e server actions enquanto está em preview", () => {
    expect(
      shouldBlockReadOnlyPreviewMutation({
        method: "POST",
        pathname: "/api/v1/orders",
        mode: READ_ONLY_PREVIEW_MODE,
      }),
    ).toBe(true);
    expect(
      shouldBlockReadOnlyPreviewMutation({
        method: "POST",
        pathname: "/onboarding/welcome",
        mode: READ_ONLY_PREVIEW_MODE,
      }),
    ).toBe(true);
    expect(
      shouldBlockReadOnlyPreviewMutation({
        method: "GET",
        pathname: "/api/v1/orders",
        mode: READ_ONLY_PREVIEW_MODE,
      }),
    ).toBe(false);
    expect(
      shouldBlockReadOnlyPreviewMutation({
        method: "POST",
        pathname: IMPERSONATE_END_PATH,
        mode: READ_ONLY_PREVIEW_MODE,
      }),
    ).toBe(false);
    expect(
      shouldBlockReadOnlyPreviewMutation({
        method: "POST",
        pathname: "/api/v1/orders",
        mode: undefined,
      }),
    ).toBe(false);
  });
});

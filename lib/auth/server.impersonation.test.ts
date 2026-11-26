import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/lib/auth/types";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  createAdminClient: vi.fn(),
  verifyImpersonateCookie: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/impersonate/cookie", () => ({
  IMPERSONATE_COOKIE_NAME: "deskcomm-impersonate",
  verifyImpersonateCookie: mocks.verifyImpersonateCookie,
}));

import { resolveActiveOrg } from "@/lib/auth/server";

const CHOPPERIA = "20e9decd-4c08-4363-a080-e088e1357ffd";
const SANDBOX = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: ADMIN,
    email: "admin@example.test",
    full_name: "Platform Admin",
    avatar_url: null,
    is_platform_admin: true,
    organizations: [
      { organization_id: SANDBOX, organization_name: "Tortas Sandbox", role: "admin" },
    ],
    ...overrides,
  };
}

function configureCookies(values: Record<string, string>) {
  mocks.cookies.mockResolvedValue({ get: (name: string) => ({ value: values[name] }) });
}

function configureOrganizationLookup() {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { id: CHOPPERIA, display_name: "Chopperia do Gordo", status: "active" },
      error: null,
    }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  mocks.createAdminClient.mockReturnValue({ from: vi.fn().mockReturnValue(query) });
  return query;
}

describe("resolveActiveOrg — impersonação", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureCookies({ active_org: SANDBOX, "deskcomm-impersonate": "signed-cookie" });
    mocks.verifyImpersonateCookie.mockReturnValue({
      valid: true,
      payload: { tenantId: CHOPPERIA, platformAdminId: ADMIN, exp: 2_000_000_000 },
    });
  });

  it("usa o tenant do cookie assinado antes da membership antiga do administrador", async () => {
    const lookup = configureOrganizationLookup();

    await expect(resolveActiveOrg(authUser())).resolves.toEqual({
      orgId: CHOPPERIA,
      name: "Chopperia do Gordo",
      role: "viewer",
    });
    expect(lookup.eq).toHaveBeenCalledWith("id", CHOPPERIA);
  });

  it("não aplica cookie de impersonation de outro usuário", async () => {
    mocks.verifyImpersonateCookie.mockReturnValue({
      valid: true,
      payload: {
        tenantId: CHOPPERIA,
        platformAdminId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        exp: 2_000_000_000,
      },
    });

    await expect(resolveActiveOrg(authUser())).resolves.toMatchObject({ orgId: SANDBOX });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("não permite que um usuário sem papel de platform admin use o cookie", async () => {
    await expect(resolveActiveOrg(authUser({ is_platform_admin: false }))).resolves.toMatchObject({
      orgId: SANDBOX,
    });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("não cai silenciosamente em outro tenant quando o alvo assinado não existe", async () => {
    const query = configureOrganizationLookup();
    query.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(resolveActiveOrg(authUser())).resolves.toBeNull();
  });
});

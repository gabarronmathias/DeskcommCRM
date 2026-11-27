import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { buildPendingInviteLink, consumePendingInviteState } from "./team-invite-link";

describe("link administrativo do convite pendente", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("recria o link do convite existente com tenant, e-mail e role assinados", () => {
    vi.stubEnv("INVITE_TOKEN_SECRET", "test-secret-for-invite-link");
    const url = buildPendingInviteLink({
      inviteId: "invite-existing",
      email: " Diretoria@GabarronMathias.com ",
      organizationId: "chopperia-org",
      role: "agent",
      expiresAt: "2030-01-01T00:00:00.000Z",
      baseUrl: "https://crm.example.com",
      now: Date.parse("2029-12-31T00:00:00.000Z"),
    });

    expect(url).not.toBeNull();
    const token = new URL(url!).pathname.split("/").at(-1)!;
    expect(verifyInviteToken(token)).toMatchObject({
      invite_id: "invite-existing",
      email: "diretoria@gabarronmathias.com",
      organization_id: "chopperia-org",
      role: "agent",
      source: "admin_onboarding",
    });
  });

  it("não emite link vencido nem em origem insegura", () => {
    const input = {
      inviteId: "invite-existing", email: "op@example.com", organizationId: "org-1",
      role: "agent" as const, expiresAt: "2029-01-01T00:00:00.000Z",
      baseUrl: "https://crm.example.com", now: Date.parse("2030-01-01T00:00:00.000Z"),
    };
    expect(buildPendingInviteLink(input)).toBeNull();
    expect(buildPendingInviteLink({ ...input, expiresAt: "2031-01-01T00:00:00.000Z", baseUrl: "http://crm.example.com" })).toBeNull();
  });

  it("consome somente o convite atual, sem persistir token", () => {
    const state = { foodservice_setup: { team_invite: { invite_id: "invite-existing", email: "op@example.com" } } };
    const consumed = consumePendingInviteState(state, "invite-existing", "2030-01-01T00:00:00.000Z");
    expect(consumed).toMatchObject({
      foodservice_setup: { team_invite: { invite_id: null, accepted_invite_id: "invite-existing", accepted_at: "2030-01-01T00:00:00.000Z" } },
    });
    expect(JSON.stringify(consumed)).not.toContain("token");
    expect(consumePendingInviteState(state, "stale-invite", "2030-01-01T00:00:00.000Z")).toBeNull();
  });
});

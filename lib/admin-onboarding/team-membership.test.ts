import { describe, expect, it, vi } from "vitest";
import { hasAcceptedTeamMembership } from "./team-membership";

function fakeAdmin(rows: { user_id: string }[], emails: Record<string, string>, queryError = false) {
  const calls: unknown[][] = [];
  const result = { data: queryError ? null : rows, error: queryError ? new Error("db") : null };
  const query = {
    select: vi.fn((...args: unknown[]) => { calls.push(["select", ...args]); return query; }),
    eq: vi.fn((...args: unknown[]) => { calls.push(["eq", ...args]); return query; }),
    not: vi.fn((...args: unknown[]) => { calls.push(["not", ...args]); return query; }),
    is: vi.fn((...args: unknown[]) => { calls.push(["is", ...args]); return query; }),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  return {
    calls,
    admin: {
      from: vi.fn(() => query),
      auth: { admin: { getUserById: vi.fn(async (id: string) => ({ data: { user: { email: emails[id] } }, error: null })) } },
    },
  };
}

describe("membership aceita do operador no tenant", () => {
  it("correlaciona e-mail autenticado e filtra tenant, role, aceite e revogação", async () => {
    const { admin, calls } = fakeAdmin([{ user_id: "user-1" }], { "user-1": " OP@EXAMPLE.COM " });

    await expect(hasAcceptedTeamMembership(admin as never, "org-1", "op@example.com", "agent")).resolves.toBe("accepted");
    expect(calls).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(calls).toContainEqual(["eq", "role", "agent"]);
    expect(calls).toContainEqual(["not", "accepted_at", "is", null]);
    expect(calls).toContainEqual(["is", "revoked_at", null]);
  });

  it("falha fechada se a consulta de membership falhar", async () => {
    const { admin } = fakeAdmin([], {}, true);
    await expect(hasAcceptedTeamMembership(admin as never, "org-1", "op@example.com", "agent")).resolves.toBe("error");
  });
});

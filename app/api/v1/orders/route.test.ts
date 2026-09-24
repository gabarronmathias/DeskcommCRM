import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const orgId = "22222222-2222-4222-8222-222222222222";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "user@example.com",
  full_name: null,
  avatar_url: null,
  is_platform_admin: false,
  organizations: [],
};

function makeSupabaseStub(rows: Array<{ id: string; external_provider: string }>) {
  const filters: Array<[string, string, unknown]> = [];
  const query = Promise.resolve({ data: rows, error: null });
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      filters.push(["eq", column, value]);
      return builder;
    }),
    in: vi.fn((column: string, values: unknown[]) => {
      filters.push(["in", column, values]);
      return builder;
    }),
    order: vi.fn(() => builder),
    limit: vi.fn(() => query),
  };
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: user.id } }, error: null }) },
    from: vi.fn(() => builder),
  };
  return { client, filters, builder };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/orders", () => {
  it("inclui pedidos Athos e Deskcomm Food sem perder o filtro da organização", async () => {
    const rows = [
      { id: "athos-order", external_provider: "athos" },
      { id: "food-order", external_provider: "deskcomm_food" },
      { id: "renamed-food-order", external_provider: "gm_crm_food" },
    ];
    const stub = makeSupabaseStub(rows);
    vi.mocked(createClient).mockResolvedValue(stub.client as never);
    vi.mocked(loadAuthUser).mockResolvedValue(user as never);
    vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId, name: "Org", role: "admin" });

    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/api/v1/orders"));
    const body = (await response.json()) as { data: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.data.map((order) => order.id)).toEqual([
      "athos-order",
      "food-order",
      "renamed-food-order",
    ]);
    expect(stub.filters).toContainEqual(["eq", "organization_id", orgId]);
    expect(stub.filters).toContainEqual([
      "in",
      "external_provider",
      ["deskcomm_food", "gm_crm_food", "athos"],
    ]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function thenable(value: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = async () => value;
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(value).then(resolve);
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    user: { id: ADMIN_ID },
    platformAdmin: { user_id: ADMIN_ID, scope: "full", mfa_required: true },
  } as never);
});

describe("GET /api/v1/admin/tenants/[id]/health", () => {
  it("não consulta integrações Nuvemshop nem as inclui na resposta", async () => {
    const tables: string[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      {
        from: (table: string) => {
          tables.push(table);
          if (table === "channel_sessions") {
            return thenable({ data: [], error: null });
          }
          if (table === "ai_budgets") return thenable({ data: [], error: null });
          if (table === "api_audit_log") {
            return thenable({ data: null, error: null });
          }
          throw new Error(`unexpected table ${table}`);
        },
      } as never,
    );

    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest(`http://localhost/api/v1/admin/tenants/${ORG_ID}/health`),
      { params: Promise.resolve({ id: ORG_ID }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(tables).not.toContain("tenant_integrations");
    expect(body.data).not.toHaveProperty("nuvemshop");
    expect(body.data).toHaveProperty("waha");
    expect(body.data).toHaveProperty("ai");
    expect(body.data).toHaveProperty("audit");
  });
});

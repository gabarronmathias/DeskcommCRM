import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));

function makeSupabase() {
  const updates: Array<Record<string, unknown>> = [];
  const current = {
    id: "internal-order-1",
    organization_id: "org-tortas",
    external_provider: "deskcomm_food",
    external_id: "sarah-test-key",
    contact_id: "contact-1",
    status: "pending",
    food_status: "accepted",
    payload: { source: "whatsapp", created_by: "sarah", conversation_id: "conv-1" },
  };
  let patch: Record<string, unknown> | null = null;
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.update = vi.fn((values: Record<string, unknown>) => {
      patch = values;
      updates.push(values);
      return builder;
    });
    builder.maybeSingle = vi.fn(async () => ({ data: table === "orders" ? current : null, error: null }));
    builder.single = vi.fn(async () => ({
      data: { ...current, ...(patch ?? {}) },
      error: null,
    }));
    return builder;
  });
  return {
    client: { from },
    updates,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/v1/orders/[id]/status", () => {
  it("allows the CRM operator to move an internal order to preparation", async () => {
    const stub = makeSupabase();
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      org: { orgId: "org-tortas", name: "Tortas Sandbox", role: "agent" },
    } as never);
    vi.mocked(createClient).mockResolvedValue(stub.client as never);

    const { PATCH } = await import("./route");
    const response = await PATCH(
      new NextRequest("http://localhost/api/v1/orders/internal-order-1/status", {
        method: "PATCH",
        body: JSON.stringify({ status: "preparing" }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: "internal-order-1" }) },
    );
    const body = (await response.json()) as { data: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(stub.updates).toEqual([{ food_status: "preparing", status: "pending" }]);
    expect(body.data).toMatchObject({
      id: "internal-order-1",
      food_status: "preparing",
      payload: { source: "whatsapp", created_by: "sarah" },
    });
  });
});

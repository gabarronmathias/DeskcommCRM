import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { deriveSandboxHmacSecret, signAthosPayload } from "@/lib/athos/contract";
import { authenticateAthosPartner } from "@/lib/athos/partner-auth";

vi.mock("@/lib/athos/partner-auth", () => ({ authenticateAthosPartner: vi.fn() }));

const orgId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const launchId = "44444444-4444-4444-8444-444444444444";
const storeRef = "athos-store";
const bearer = "dsk_partner_test_token_12345678901234567890";
const event = {
  event_id: "evt-order-1",
  event_type: "order.created",
  occurred_at: new Date().toISOString(),
  store_ref: storeRef,
  correlation: { launch_id: launchId, crm_contact_id: contactId, crm_conversation_id: conversationId },
  customer: { athos_customer_id: "athos-customer-1", name: "Cliente", phone: "+5511999999999" },
  order: {
    id: "athos-order-1", status: "pending", total_cents: 1700, currency: "BRL",
    created_at: new Date().toISOString(),
    items: [{ product_id: "athos-product-1", name: "Torta", quantity: 1, unit_price_cents: 1700, line_total_cents: 1700, modifiers: [] }],
  },
};

function configureAdmin(overrides: { launch?: Record<string, unknown> | null; rpc?: unknown } = {}) {
  const launchQuery = {
    select: vi.fn(() => launchQuery),
    eq: vi.fn(() => launchQuery),
    maybeSingle: vi.fn().mockResolvedValue({ data: overrides.launch === undefined ? {
      id: launchId, contact_id: contactId, conversation_id: conversationId, store_ref: storeRef,
    } : overrides.launch, error: null }),
  };
  const admin = {
    from: vi.fn(() => launchQuery),
    rpc: vi.fn().mockResolvedValue({ data: overrides.rpc ?? { order_id: "crm-order-1", duplicate: false }, error: null }),
  };
  vi.mocked(authenticateAthosPartner).mockResolvedValue({
    auth: { organizationId: orgId, apiTokenId: "token-1" } as never,
    admin: admin as never,
    integration: { organization_id: orgId } as never,
    storeRef,
  } as never);
  return { admin, launchQuery };
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/partners/athos/events", () => {
  it("verifies and correlates the event before projecting the order", async () => {
    const { admin } = configureAdmin();
    const rawBody = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const request = new NextRequest("http://localhost/api/v1/partners/athos/events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "x-athos-timestamp": timestamp,
        "x-athos-signature": signAthosPayload(timestamp, rawBody, deriveSandboxHmacSecret(bearer)),
      },
      body: rawBody,
    });
    const { POST } = await import("./route");
    const response = await POST(request);

    expect(response.status).toBe(202);
    expect(admin.rpc).toHaveBeenCalledWith("fn_apply_athos_order_event", {
      p_organization_id: orgId,
      p_contact_id: contactId,
      p_conversation_id: conversationId,
      p_event: expect.objectContaining({ event_id: "evt-order-1" }),
    });
  });

  it("rejects a correlation mismatch without writing an order", async () => {
    const { admin } = configureAdmin({ launch: { id: launchId, contact_id: contactId, conversation_id: conversationId, store_ref: storeRef } });
    const mismatched = { ...event, correlation: { ...event.correlation, crm_contact_id: "55555555-5555-4555-8555-555555555555" } };
    const rawBody = JSON.stringify(mismatched);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const request = new NextRequest("http://localhost/api/v1/partners/athos/events", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "x-athos-timestamp": timestamp,
        "x-athos-signature": signAthosPayload(timestamp, rawBody, deriveSandboxHmacSecret(bearer)) },
      body: rawBody,
    });
    const { POST } = await import("./route");
    const response = await POST(request);
    expect(response.status).toBe(422);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("rejects stale signed requests", async () => {
    const { admin } = configureAdmin();
    const rawBody = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000) - 600);
    const request = new NextRequest("http://localhost/api/v1/partners/athos/events", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "x-athos-timestamp": timestamp,
        "x-athos-signature": signAthosPayload(timestamp, rawBody, deriveSandboxHmacSecret(bearer)) },
      body: rawBody,
    });
    const { POST } = await import("./route");
    expect((await POST(request)).status).toBe(401);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});

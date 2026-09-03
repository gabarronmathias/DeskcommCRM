import { describe, expect, it } from "vitest";

import {
  athosEventSchema,
  hashBearerToken,
  isFreshAthosTimestamp,
  signAthosPayload,
  verifyAthosSignature,
} from "./contract";

const validEvent = {
  event_id: "evt_test_0001",
  event_type: "order.created",
  occurred_at: "2026-09-03T11:00:00.000Z",
  store_ref: "5b7b4a38-4c54-488e-986f-9ea0428cff7a",
  correlation: {
    launch_id: "b6db408d-d4a8-43b6-b057-060241e6db74",
    crm_contact_id: "334615f4-af47-42fb-a930-f907613ff6f0",
  },
  customer: {
    athos_customer_id: "customer_test_1",
    name: "Cliente Sandbox",
    phone: "+5511999999999",
  },
  order: {
    id: "A-TEST-10492",
    status: "confirmed",
    total_cents: 9400,
    subtotal_cents: 8500,
    delivery_fee_cents: 900,
    discount_cents: 0,
    currency: "BRL",
    created_at: "2026-09-03T10:59:58.000Z",
    updated_at: "2026-09-03T11:00:00.000Z",
    items: [
      {
        product_id: "prod_test_123",
        sku: "SKU-TEST-123",
        name: "Produto de teste",
        quantity: 2,
        unit_price_cents: 3500,
        line_total_cents: 7000,
        modifiers: [],
      },
    ],
  },
} as const;

describe("Athos partner contract", () => {
  it("accepts the documented order event envelope", () => {
    expect(athosEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it("rejects unsupported order statuses", () => {
    const invalid = {
      ...validEvent,
      order: { ...validEvent.order, status: "unknown" },
    };
    expect(athosEventSchema.safeParse(invalid).success).toBe(false);
  });

  it("signs and verifies timestamp.rawBody with HMAC-SHA256", () => {
    const timestamp = "1788433200";
    const rawBody = JSON.stringify(validEvent);
    const secret = "sandbox-secret";
    const signature = signAthosPayload(timestamp, rawBody, secret);

    expect(signature).toMatch(/^v1=[a-f0-9]{64}$/);
    expect(verifyAthosSignature(timestamp, rawBody, signature, secret)).toBe(true);
    expect(verifyAthosSignature(timestamp, `${rawBody} `, signature, secret)).toBe(false);
  });

  it("enforces the five-minute anti-replay window", () => {
    const nowMs = Date.UTC(2026, 8, 3, 11, 0, 0);
    const nowSeconds = String(Math.floor(nowMs / 1000));
    const oldSeconds = String(Math.floor((nowMs - 301_000) / 1000));

    expect(isFreshAthosTimestamp(nowSeconds, nowMs)).toBe(true);
    expect(isFreshAthosTimestamp(oldSeconds, nowMs)).toBe(false);
  });

  it("hashes bearer tokens without preserving plaintext", () => {
    const token = "dsk_example_secret_token_123456";
    const hash = hashBearerToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
  });
});
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const athosEventSchema = z.object({
  event_id: z.string().min(1).max(200),
  event_type: z.enum([
    "order.created",
    "order.updated",
    "order.status_changed",
    "order.completed",
    "order.cancelled",
  ]),
  occurred_at: z.string().datetime({ offset: true }),
  store_ref: z.string().min(1).max(160),
  correlation: z.object({
    launch_id: z.string().uuid(),
    crm_contact_id: z.string().uuid().optional(),
    crm_conversation_id: z.string().uuid().optional(),
  }),
  customer: z.object({
    athos_customer_id: z.string().max(200).optional(),
    name: z.string().max(200).optional(),
    phone: z.string().max(40).optional(),
  }).optional(),
  order: z.object({
    id: z.string().min(1).max(200),
    status: z.enum(["pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed", "cancelled"]),
    total_cents: z.number().int().nonnegative(),
    subtotal_cents: z.number().int().nonnegative().optional(),
    delivery_fee_cents: z.number().int().nonnegative().optional(),
    discount_cents: z.number().int().nonnegative().optional(),
    currency: z.string().length(3).default("BRL"),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }).optional(),
    items: z.array(z.object({
      product_id: z.string().min(1).max(200),
      sku: z.string().max(200).optional(),
      name: z.string().min(1).max(300),
      quantity: z.number().int().min(1).max(999),
      unit_price_cents: z.number().int().nonnegative(),
      line_total_cents: z.number().int().nonnegative(),
      modifiers: z.array(z.record(z.string(), z.unknown())).default([]),
    })).min(1).max(200),
  }),
}).passthrough();

export type AthosEvent = z.infer<typeof athosEventSchema>;

export function deriveSandboxHmacSecret(bearer: string): string {
  return createHash("sha256").update(`deskcomm-athos-sandbox-v1:${bearer}`).digest("hex");
}

export function isFreshAthosTimestamp(timestamp: string, nowMs = Date.now()): boolean {
  if (!/^\d{10}$/.test(timestamp)) return false;
  return Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) <= 300;
}

export function signAthosPayload(timestamp: string, rawBody: string, secret: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function verifyAthosSignature(timestamp: string, rawBody: string, signature: string | null, secret: string): boolean {
  if (!/^v1=[a-f\d]{64}$/i.test(signature ?? "")) return false;
  const expected = Buffer.from(signAthosPayload(timestamp, rawBody, secret).slice(3), "hex");
  const received = Buffer.from((signature ?? "").slice(3), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

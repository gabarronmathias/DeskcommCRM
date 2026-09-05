import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const ATHOS_EVENT_TYPES = [
  "order.created",
  "order.updated",
  "order.status_changed",
  "order.completed",
  "order.cancelled",
] as const;

export const ATHOS_ORDER_STATUSES = [
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "out_for_delivery",
  "completed",
  "cancelled",
] as const;

export const ATHOS_REPLAY_WINDOW_SECONDS = 5 * 60;
export const ATHOS_RATE_LIMIT_PER_MINUTE = 120;
export const ATHOS_LAUNCH_TTL_MINUTES = 10;

const dateTimeString = z.string().min(1).refine((value) => Number.isFinite(Date.parse(value)), {
  message: "invalid_datetime",
});

const modifierSchema = z.record(z.string(), z.unknown());

export const athosEventSchema = z
  .object({
    event_id: z.string().min(1).max(200),
    event_type: z.enum(ATHOS_EVENT_TYPES),
    occurred_at: dateTimeString,
    store_ref: z.string().min(1).max(160),
    correlation: z
      .object({
        launch_id: z.string().uuid().optional(),
        crm_contact_id: z.string().uuid().optional(),
        crm_conversation_id: z.string().uuid().optional(),
      })
      .optional(),
    customer: z
      .object({
        athos_customer_id: z.string().max(200).optional(),
        name: z.string().max(200).optional(),
        phone: z.string().max(40).optional(),
      })
      .optional(),
    order: z.object({
      id: z.string().min(1).max(200),
      status: z.enum(ATHOS_ORDER_STATUSES),
      total_cents: z.number().int().nonnegative(),
      subtotal_cents: z.number().int().nonnegative().optional(),
      delivery_fee_cents: z.number().int().nonnegative().optional(),
      discount_cents: z.number().int().nonnegative().optional(),
      currency: z.string().length(3).default("BRL"),
      created_at: dateTimeString,
      updated_at: dateTimeString.optional(),
      items: z
        .array(
          z.object({
            product_id: z.string().min(1).max(200),
            sku: z.string().max(200).optional(),
            name: z.string().min(1).max(300),
            quantity: z.number().int().min(1).max(999),
            unit_price_cents: z.number().int().nonnegative(),
            line_total_cents: z.number().int().nonnegative(),
            modifiers: z.array(modifierSchema).default([]),
          }),
        )
        .min(1)
        .max(200),
    }),
  })
  .passthrough();

export type AthosEvent = z.infer<typeof athosEventSchema>;

export function extractBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length >= 16 ? token : null;
}

export function hashBearerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Sandbox-only credential derivation.
 *
 * We intentionally persist only bearer_hash. The HMAC secret is derived from the
 * bearer presented on the authenticated request, so no reversible partner secret
 * exists at rest in Supabase. Production must use independent encrypted secrets.
 */
export function deriveAthosSandboxHmacSecret(bearerToken: string): string {
  return createHash("sha256")
    .update(`deskcomm-athos-sandbox-v1:${bearerToken}`, "utf8")
    .digest("hex");
}

export function generateAthosCredentials(): { bearer: string; hmacSecret: string } {
  const bearer = `dsk_${randomBytes(32).toString("base64url")}`;
  return {
    bearer,
    hmacSecret: deriveAthosSandboxHmacSecret(bearer),
  };
}

export function signAthosPayload(timestamp: string, rawBody: string, secret: string): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  return `v1=${digest}`;
}

export function verifyAthosSignature(
  timestamp: string,
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!/^v1=[a-fA-F0-9]{64}$/.test(signatureHeader ?? "")) return false;

  const expected = Buffer.from(signAthosPayload(timestamp, rawBody, secret).slice(3), "hex");
  const received = Buffer.from((signatureHeader ?? "").slice(3), "hex");
  if (received.length !== expected.length) return false;

  try {
    return timingSafeEqual(received, expected);
  } catch {
    return false;
  }
}

export function isFreshAthosTimestamp(timestamp: string, nowMs = Date.now()): boolean {
  if (!/^[0-9]{10}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return false;
  return Math.abs(Math.floor(nowMs / 1000) - seconds) <= ATHOS_REPLAY_WINDOW_SECONDS;
}

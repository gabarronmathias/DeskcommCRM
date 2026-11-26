import { z } from "zod";

export const companyProfileSchema = z.object({
  responsible_name: z.string().trim().min(2).max(120),
  address: z.string().trim().max(300).optional().default(""),
  phone: z.string().trim().max(40).optional().default(""),
  sarah_name: z.string().trim().min(2).max(80),
});

export const operationSchema = z.object({
  business_days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).min(1),
  opens_at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  closes_at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  delivery_enabled: z.boolean(),
  pickup_enabled: z.boolean(),
  service_areas: z.array(z.string().trim().min(2).max(100)).max(80),
  delivery_fee_cents: z.number().int().min(0).max(100000),
  minimum_order_cents: z.number().int().min(0).max(1000000),
  average_prep_minutes: z.number().int().min(1).max(600),
  payment_methods: z.array(z.enum(["pix", "cash", "credit_card", "debit_card"])).min(1),
}).refine((value) => value.delivery_enabled || value.pickup_enabled, {
  message: "Ative entrega, retirada ou ambas.",
});

export const sarahSettingsSchema = z.object({
  name: z.string().trim().min(2).max(80),
  greeting: z.string().trim().max(1200),
  rules: z.string().trim().max(8000),
  commercial_guidance: z.string().trim().max(4000),
  priority_products: z.string().trim().max(2000),
  upsell_guidance: z.string().trim().max(2000),
  handoff_guidance: z.string().trim().max(2000),
});

export const operatorSettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  role: z.enum(["agent", "manager"]),
  handoff_responsible: z.boolean(),
});

export const catalogProductSchema = z.object({
  product_id: z.string().uuid(),
  price_cents: z.number().int().min(0).max(10000000),
  is_available: z.boolean(),
});

export const newCatalogProductSchema = z.object({
  category_id: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional().default(""),
  price_cents: z.number().int().min(0).max(10000000),
});

export const newCatalogCategorySchema = z.object({
  name: z.string().trim().min(2).max(80),
});

export const onboardingStepSchema = z.enum([
  "company", "operation", "catalog", "sarah", "team", "whatsapp", "checklist",
]);

export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest, NextResponse } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ tenant: string }>;
}

const itemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(99),
  modifier_ids: z.array(z.string().uuid()).max(30).default([]),
  recommendation_rule_id: z.string().uuid().nullable().optional(),
});

const checkoutSchema = z.object({
  idempotency_key: z.string().trim().min(8).max(128),
  session_key: z.string().trim().min(6).max(160),
  customer_name: z.string().trim().min(1).max(160),
  phone: z.string().trim().min(8).max(30),
  fulfillment: z.enum(["retirada", "entrega"]),
  payment_method: z.enum(["pix", "cartao", "cartão", "dinheiro"]),
  address_notes: z.string().max(500).optional().default(""),
  marketing_consent: z.boolean().optional().default(false),
  items: z.array(itemSchema).min(1).max(50),
});

function opaque(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return req.headers.get("x-real-ip")?.trim() || null;
}

function rpcStatus(code: string | undefined): number {
  if (code === "P0002") return 404;
  if (code === "22023") return 422;
  if (code === "23505") return 409;
  if (code === "42501") return 403;
  return 500;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { tenant } = await ctx.params;
  const slug = tenant.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    return fail("not_found", "Cardápio não encontrado.", 404, { requestId });
  }

  // O catálogo é público por esta rota, mas a RPC é SECURITY DEFINER e não deve
  // ficar diretamente exposta à anon key. A rota valida o slug e é a fronteira
  // pública única; o banco aceita a chamada somente do service role.
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("fn_food_public_catalog", {
    p_tenant_slug: slug,
  });

  if (error) {
    if (error.code === "P0002") {
      return fail("not_found", "Cardápio não encontrado.", 404, { requestId });
    }
    logger.error("[food.catalog] rpc failed", {
      tenant: slug,
      errorCode: error.code,
      errorMessage: error.message,
    });
    return fail("internal_error", "Não foi possível carregar o cardápio.", 500, { requestId });
  }

  return ok(data, {
    requestId,
    headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=120" },
  });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { tenant } = await ctx.params;
  const slug = tenant.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
    return fail("not_found", "Cardápio não encontrado.", 404, { requestId });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "JSON inválido.", 400, { requestId });
  }

  const parsed = checkoutSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", "Dados do pedido inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const body = parsed.data;

  const origin = clientIp(req);
  const limiterId = origin ? `ip:${opaque(origin)}` : `session:${opaque(body.session_key)}`;
  const rl = await checkRateLimit(`food_checkout:${slug}:${limiterId}`, 20, 60);
  if (!rl.allowed) {
    return fail("rate_limited", "Muitos pedidos em pouco tempo. Tente novamente em instantes.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  // Exceção deliberada ao uso genérico do admin client: esta rota chama SOMENTE
  // a RPC fn_food_checkout. A função resolve o tenant pelo slug do path, valida
  // produtos/adicionais/regras no banco e recalcula o preço; nenhum table write
  // é montado a partir do body nesta camada.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_food_checkout", {
    p_tenant_slug: slug,
    p_idempotency_key: body.idempotency_key,
    p_session_key: body.session_key,
    p_customer_name: body.customer_name,
    p_phone: body.phone,
    p_fulfillment: body.fulfillment,
    p_payment_method: body.payment_method,
    p_address_notes: body.address_notes,
    p_marketing_consent: body.marketing_consent,
    p_items: body.items.map((item) => ({
      ...item,
      recommendation_rule_id: item.recommendation_rule_id ?? undefined,
    })),
  });

  if (error) {
    const status = rpcStatus(error.code);
    logger.warn("[food.checkout] rpc rejected", {
      tenant: slug,
      errorCode: error.code,
      errorMessage: error.message,
      status,
    });
    if (status >= 500) {
      return fail("internal_error", "Não foi possível criar o pedido.", 500, { requestId });
    }
    const publicMessage =
      status === 404
        ? "Produto ou cardápio indisponível. Atualize a página e tente novamente."
        : status === 409
          ? "Esta chave de pedido já foi usada com dados diferentes."
          : "Revise os dados do pedido e tente novamente.";
    return fail("invalid_request", publicMessage, status, { requestId });
  }

  return ok(data, { status: 201, requestId });
}

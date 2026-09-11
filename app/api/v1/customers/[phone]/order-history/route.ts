/**
 * GET /api/v1/customers/[phone]/order-history
 *
 * EPIC-21 (Athos): API de histórico de vendas por cliente para a Sarah (motor
 * de relacionamento foodservice) e para o time Athos consultarem o que um
 * cliente já comprou, quanto gastou, quando foi a última compra e quais são
 * seus produtos favoritos — base para campanhas de recompra e reativação.
 *
 * Auth: Bearer `dsk_...` (api_tokens). Reusa `validateBearerToken` e exige o
 * scope granular `orders:read` (já existe no catálogo MCP). Audit fire-and-
 * forget em `api_audit_log` (action `orders.read.history`).
 *
 * Não usa cookie: Athos é server-to-server e a Sarah consulta via MCP tool
 * (que tem o próprio auth). UI humana usa `/api/v1/orders` (cookie) para a
 * lista simples e esta rota quando precisar do agregado + recência.
 *
 * Toda a lógica de query fica na RPC `fn_orders_customer_history`
 * (supabase/migrations/20260911184300_0176_orders_customer_history_rpc.sql) —
 * SECURITY INVOKER + STABLE + filtro manual de `organization_id`. Aqui só
 * validamos input, propagamos para a RPC e devolvemos.
 *
 * Multi-tenancy: o `organizationId` do token vai como `p_org` na RPC; a RPC
 * filtra TUDO por ele. Mesmo se o cliente for encontrado em outra org (im-
 * possível pelo índice único de phone, mas em tese), a página de pedidos e
 * os agregados voltam vazios. Defesa em profundidade.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import {
  ensureScope,
  McpAuthError,
  validateBearerToken,
} from "@/lib/mcp/auth";
import {
  customerPhoneParamSchema,
  orderHistoryQuerySchema,
} from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ORDERS_READ_SCOPE = "orders:read";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ phone: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const ip = req.headers.get("x-forwarded-for") ?? null;
  const userAgent = req.headers.get("user-agent") ?? null;

  // 1. Auth bearer (server-to-server). 401 se ausente/malformado/expirado.
  let auth;
  try {
    auth = await validateBearerToken(req.headers.get("authorization"));
  } catch (err) {
    if (err instanceof McpAuthError) {
      return fail("unauthenticated", err.message, err.httpStatus, { requestId });
    }
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  // 2. Scope granular: `orders:read`. 403 sem ele.
  try {
    ensureScope(auth.scopes, ORDERS_READ_SCOPE);
  } catch (err) {
    if (err instanceof McpAuthError) {
      return fail("forbidden_scope", err.message, err.httpStatus, { requestId });
    }
    throw err;
  }

  // 3. Path param: telefone (regex permissiva; a RPC normaliza via
  //    fn_food_normalize_phone).
  const params = await ctx.params;
  const phoneParsed = customerPhoneParamSchema.safeParse(params.phone);
  if (!phoneParsed.success) {
    return fail(
      "validation_failed",
      "Telefone inválido. Use 8+ dígitos com ou sem separadores (+, espaço, -, (, )).",
      422,
      { requestId, details: phoneParsed.error.flatten() },
    );
  }

  // 4. Query params (Zod): filtros opcionais.
  const url = new URL(req.url);
  const queryParsed = orderHistoryQuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!queryParsed.success) {
    return fail(
      "validation_failed",
      "Parâmetros de busca inválidos.",
      422,
      { requestId, details: queryParsed.error.flatten() },
    );
  }
  const q = queryParsed.data;

  // 5. RPC. SECURITY INVOKER + admin client = atravessa RLS; o filtro manual
  //    de `organization_id` dentro da função é o que isola. Se o token for de
  //    outra org, a função retorna `customer_found=false`.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_orders_customer_history", {
    p_org: auth.organizationId,
    p_phone: phoneParsed.data,
    p_from: q.from ?? null,
    p_to: q.to ?? null,
    p_status: q.status ?? null,
    p_limit: q.limit,
    p_cursor: q.cursor ?? null,
  });

  if (error) {
    // 22023 da fn_food_normalize_phone = phone_required / phone_invalid /
    // cursor_invalid; devolvemos 422 em vez de 500 porque é erro de input.
    if (error.code === "22023") {
      return fail("validation_failed", error.message, 422, { requestId });
    }
    return fail("internal_error", "Não foi possível carregar o histórico.", 500, {
      requestId,
      details: { message: error.message, code: error.code },
    });
  }

  const payload = data as {
    customer_found: boolean;
    query_phone_e164: string;
    customer: Record<string, unknown> | null;
    summary: Record<string, unknown>;
    orders: Array<Record<string, unknown>>;
    next_cursor: string | null;
  };

  // 6. Audit fire-and-forget. Quem consultou, qual telefone, quantos pedidos.
  //    `actor_api_token_id` no lugar de `actor_user_id` porque o caller é
  //    server-to-server (bearer).
  void audit({
    action: "orders.read.history",
    actorUserId: null,
    actorApiTokenId: auth.apiTokenId,
    organizationId: auth.organizationId,
    resourceType: "contact",
    resourceId:
      typeof payload.customer?.id === "string" ? payload.customer.id : null,
    requestId,
    ip,
    userAgent,
    metadata: {
      query_phone_e164: payload.query_phone_e164,
      customer_found: payload.customer_found,
      orders_returned: payload.orders?.length ?? 0,
      filters: {
        from: q.from ?? null,
        to: q.to ?? null,
        status: q.status ?? null,
        limit: q.limit,
      },
    },
  });

  // 7. Resposta. `next_cursor` null = última página; `has_more` derivado.
  return ok(
    {
      customer_found: payload.customer_found,
      query_phone_e164: payload.query_phone_e164,
      customer: payload.customer,
      summary: payload.summary,
      orders: payload.orders,
    },
    {
      requestId,
      meta: {
        cursor: payload.next_cursor,
        has_more: payload.next_cursor != null,
      },
    },
  );
}

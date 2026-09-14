/**
 * GET /api/v1/customers/purchase-recency
 *
 * EPIC-21 (Athos) PARTE 3: audiencia de campanha por recorrencia de compra.
 * Time Athos consulta quem esta inativo ha X dias pra montar campanhas de
 * reativacao; a Sarah usa via MCP tool (mesma RPC) durante a conversa com
 * o cliente ("voce nao pede faz tempo, quer experimentar X?").
 *
 * Auth: Bearer `dsk_...` (api_tokens) com scope `orders:read`. Reusa o padrao
 * da rota `/api/v1/customers/[phone]/order-history` (bearer + scope).
 *
 * LGPD: a RPC ja exclui is_blocked / is_anonymized / opt-out de marketing.
 * NAO duplicamos o filtro aqui pra evitar drift entre as duas frentes.
 *
 * Multi-tenancy: `organizationId` do token vai como `p_org` na RPC; filtro
 * manual dentro dela isola. Service-role atravessa RLS e o filtro explicito
 * da RPC garante isolamento. User autenticado com RLS mais o filtro explicito
 * = defesa em profundidade.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import {
  ensureScope,
  McpAuthError,
  validateBearerToken,
} from "@/lib/mcp/auth";
import { purchaseRecencyQuerySchema } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ORDERS_READ_SCOPE = "orders:read";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const ip = req.headers.get("x-forwarded-for") ?? null;
  const userAgent = req.headers.get("user-agent") ?? null;

  // 1. Auth bearer.
  let auth;
  try {
    auth = await validateBearerToken(req.headers.get("authorization"));
  } catch (err) {
    if (err instanceof McpAuthError) {
      return fail("unauthenticated", err.message, err.httpStatus, { requestId });
    }
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  // 2. Scope granular: `orders:read`.
  try {
    ensureScope(auth.scopes, ORDERS_READ_SCOPE);
  } catch (err) {
    if (err instanceof McpAuthError) {
      return fail("forbidden_scope", err.message, err.httpStatus, { requestId });
    }
    throw err;
  }

  // 3. Query params (Zod).
  const url = new URL(req.url);
  const queryParsed = purchaseRecencyQuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!queryParsed.success) {
    return fail("validation_failed", "Parametros invalidos.", 422, {
      requestId,
      details: queryParsed.error.flatten(),
    });
  }
  const q = queryParsed.data;

  // 4. RPC. SECURITY INVOKER + admin client = atravesa RLS; o filtro manual
  //    de `organization_id` dentro da funcao isola. Se o token for de outra
  //    org, o filtro nao vazaria (a RLS + o filtro retornam zero candidatos).
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_customers_by_purchase_recency", {
    p_org: auth.organizationId,
    p_inactive_days: q.inactive_days,
    p_min_orders: q.min_orders,
    p_min_spent_cents: q.min_spent_cents,
    p_status: q.status,
    p_limit: q.limit,
    p_cursor: q.cursor ?? null,
    p_has_orders: q.has_orders,
  });

  if (error) {
    // 22023 = inactive_days_out_of_range / cursor_invalid.
    if (error.code === "22023") {
      return fail("validation_failed", error.message, 422, { requestId });
    }
    return fail("internal_error", "Nao foi possivel carregar a audiencia.", 500, {
      requestId,
      details: { message: error.message, code: error.code },
    });
  }

  const payload = data as {
    candidates: Array<Record<string, unknown>>;
    next_cursor: string | null;
    inactive_days: number;
    min_orders: number;
    min_spent_cents: number;
    has_orders: boolean;
    queried_at: string;
  };

  // 5. Audit fire-and-forget. `actor_api_token_id` porque bearer. Metadata
  //    inclui filtros aplicados pra auditoria LGPD (quem solicitou, pra
  //    qual janela, com quais criterios).
  void audit({
    action: "orders.read.history",
    actorUserId: null,
    actorApiTokenId: auth.apiTokenId,
    organizationId: auth.organizationId,
    resourceType: "contact_audience",
    resourceId: null,
    requestId,
    ip,
    userAgent,
    metadata: {
      source: "purchase-recency",
      inactive_days: q.inactive_days,
      min_orders: q.min_orders,
      min_spent_cents: q.min_spent_cents,
      status: q.status,
      has_orders: q.has_orders,
      candidates_returned: payload.candidates?.length ?? 0,
    },
  });

  // 6. Resposta.
  return ok(
    {
      candidates: payload.candidates,
      filters: {
        inactive_days: payload.inactive_days,
        min_orders: payload.min_orders,
        min_spent_cents: payload.min_spent_cents,
        has_orders: payload.has_orders,
        queried_at: payload.queried_at,
      },
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

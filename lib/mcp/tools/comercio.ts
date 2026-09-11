/**
 * Capacidades de COMÉRCIO — o que o cliente já comprou e o que existe à venda.
 *
 * Ficou de fora do épico até ser cobrado, e era a lacuna mais direta do pilar 1:
 * um agente de vendas que não enxerga o catálogo nem o histórico de pedidos
 * negocia no escuro — promete o que não existe, ou repete uma oferta que o
 * cliente já comprou.
 *
 * Service role bypassa RLS: TODA query filtra `organization_id` manualmente, e a
 * fonte é sempre `ctx.organizationId` (token/cookie), NUNCA o input.
 */
import { z } from "zod";

import { audit } from "@/lib/audit";

import type { McpToolDefinition } from "../types";

// ---------------------------------------------------------------------------
// pedidos de um cliente
// ---------------------------------------------------------------------------

const pedidosInputShape = {
  contact_id: z.string().uuid().describe("O cliente cujos pedidos se quer ver."),
  limite: z.number().int().min(1).max(20).optional().default(10),
};

export const crmListContactOrders: McpToolDefinition<typeof pedidosInputShape> = {
  name: "crm_list_contact_orders",
  description:
    "Lista os pedidos de um contato, do mais recente para o mais antigo, com status, valor, " +
    "forma de pagamento, situação de entrega e código de rastreio. Use antes de prometer prazo " +
    "ou repetir oferta: o cliente pode já ter comprado.",
  inputSchema: pedidosInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  requiresAdditionalScopes: ["orders:read"],
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("orders")
      .select(
        "id, external_id, external_provider, status, total_cents, currency, payment_method, fulfillment_status, tracking_code, ordered_at, is_anonymized",
      )
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", input.contact_id)
      .order("ordered_at", { ascending: false, nullsFirst: false })
      .limit(input.limite);

    if (error) throw new Error(`listar_pedidos_falhou: ${error.message}`);

    return {
      pedidos: (data ?? []).map((p) => ({
        ...p,
        // Pedido anonimizado por LGPD continua contando para histórico, mas o
        // conteúdo não volta: dizer isso é melhor que devolver campos vazios e
        // deixar o modelo concluir que o cliente nunca comprou.
        ...(p.is_anonymized ? { aviso: "pedido anonimizado a pedido do titular" } : {}),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// histórico completo de um cliente (EPIC-21 Athos) — Sarah usa pra campanhas
// ---------------------------------------------------------------------------

const orderHistoryInputShape = {
  phone: z
    .string()
    .trim()
    .min(8)
    .max(32)
    .describe(
      "Telefone do cliente em qualquer formato comum (com/sem +55, espaços, parênteses). " +
        "A RPC normaliza para E.164 antes de buscar.",
    ),
  from: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("ISO-8601; pedidos a partir de (inclusivo)."),
  to: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("ISO-8601; pedidos até (exclusivo)."),
  status: z
    .enum([
      "pending",
      "paid",
      "cancelled",
      "fulfilled",
      "shipped",
      "delivered",
      "refunded",
      "not_cancelled",
      "completed",
    ])
    .optional()
    .describe("Filtro de status (canônico ou pseudo-status)."),
  limit: z.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().optional(),
};

export const crmGetCustomerOrderHistory: McpToolDefinition<typeof orderHistoryInputShape> = {
  name: "crm_get_customer_order_history",
  description:
    "Histórico de compras de um cliente pelo telefone: total de pedidos, valor gasto, ticket " +
    "médio, primeira/última compra, dias desde a última, top 5 produtos por frequência e a " +
    "lista paginada de pedidos com itens. Use antes de propor recompra, reativação ou campanha: " +
    "sem este histórico, Sarah negocia no escuro — pode estar oferecendo o que o cliente acabou " +
    "de comprar, ou propondo um produto que nunca foi dele. Se o telefone não bate em nenhum " +
    "contato, devolve { customer_found: false } com summary zerado (não é 404 — cliente novo " +
    "também é informação útil para campanhas cold-lead).",
  inputSchema: orderHistoryInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  requiresAdditionalScopes: ["orders:read"],
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase.rpc("fn_orders_customer_history", {
      p_org: ctx.organizationId,
      p_phone: input.phone,
      p_from: input.from ?? null,
      p_to: input.to ?? null,
      p_status: input.status ?? null,
      p_limit: input.limit,
      p_cursor: input.cursor ?? null,
    });

    if (error) {
      // 22023 da fn_food_normalize_phone = phone_required / phone_invalid;
      // cursor_invalid. Traduz pra uma mensagem que o MODELO entende e decide
      // o que perguntar ao cliente — sem virar um "erro interno" genérico.
      if (error.code === "22023") {
        throw new Error(`parametros_invalidos: ${error.message}`);
      }
      throw new Error(`historico_falhou: ${error.message}`);
    }

    const payload = data as {
      customer_found: boolean;
      query_phone_e164: string;
      customer: Record<string, unknown> | null;
      summary: Record<string, unknown>;
      orders: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };

    // Audit fire-and-forget — mesma action da API REST, mesmo rationale.
    // Em tools MCP o actor é o ai_agents.id, não o user; o `requestId` já vem
    // do ctx (correlation do turno).
    const a =
      ctx.actor.type === "user"
        ? { actorUserId: ctx.actor.id as string | null, actorApiTokenId: null }
        : { actorUserId: null, actorApiTokenId: ctx.apiTokenId };
    void audit({
      action: "orders.read.history",
      actorUserId: a.actorUserId,
      actorApiTokenId: a.actorApiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "contact",
      resourceId:
        typeof payload.customer?.id === "string" ? payload.customer.id : null,
      requestId: ctx.requestId,
      metadata: {
        source: "mcp",
        query_phone_e164: payload.query_phone_e164,
        customer_found: payload.customer_found,
        orders_returned: payload.orders?.length ?? 0,
        filters: {
          from: input.from ?? null,
          to: input.to ?? null,
          status: input.status ?? null,
          limit: input.limit,
        },
      },
    });

    return payload;
  },
};

// ---------------------------------------------------------------------------
// buscar no catálogo
// ---------------------------------------------------------------------------

const produtosInputShape = {
  termo: z.string().trim().min(2).describe("Parte do nome do produto."),
  limite: z.number().int().min(1).max(20).optional().default(10),
  somente_disponiveis: z.boolean().optional().default(true),
};

export const crmSearchProducts: McpToolDefinition<typeof produtosInputShape> = {
  name: "crm_search_products",
  description:
    "Busca produtos do catálogo da loja por parte do nome. Devolve preço, quantidade disponível " +
    "e link. Use para responder preço e disponibilidade com o dado da loja em vez de estimar.",
  inputSchema: produtosInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  requiresAdditionalScopes: ["products:read"],
  handler: async (input, ctx) => {
    let q = ctx.supabase
      .from("nuvemshop_products")
      .select("id, external_id, title, description, price_cents, available_qty, url, image_url")
      .eq("organization_id", ctx.organizationId)
      .ilike("title", `%${input.termo}%`)
      .limit(input.limite);

    // Oferecer o que está sem estoque é pior que não achar: o cliente ouve um
    // sim e recebe um não depois.
    if (input.somente_disponiveis) q = q.gt("available_qty", 0);

    const { data, error } = await q;
    if (error) throw new Error(`buscar_produtos_falhou: ${error.message}`);

    return {
      produtos: data ?? [],
      ...(data && data.length === 0
        ? { aviso: input.somente_disponiveis ? "nada com esse nome em estoque" : "nada com esse nome no catálogo" }
        : {}),
    };
  },
};

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
    "Busca produtos do cardápio pelo nome e devolve nome, descrição, preço e disponibilidade. " +
    "Use para responder perguntas sobre produtos, preços e disponibilidade usando o cardápio oficial do estabelecimento.",
  inputSchema: produtosInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  requiresAdditionalScopes: ["products:read"],
  handler: async (input, ctx) => {
    let q = ctx.supabase
      .from("food_products")
      .select("id, name, description, price_cents, is_available, image_url, sku, category_id")
      .eq("organization_id", ctx.organizationId)
      .ilike("name", `%${input.termo}%`)
      .limit(input.limite);

    if (input.somente_disponiveis) q = q.eq("is_available", true);

    const { data, error } = await q;
    if (error) throw new Error(`buscar_produtos_falhou: ${error.message}`);

    return {
      produtos: data ?? [],
      ...(data && data.length === 0
        ? { aviso: input.somente_disponiveis ? "nenhum produto disponível com esse nome no cardápio" : "nenhum produto com esse nome no cardápio" }
        : {}),
    };
  },
};

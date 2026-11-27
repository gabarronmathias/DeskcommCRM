import { describe, expect, it, vi } from "vitest";

import { crmSearchProducts } from "./comercio";
import type { McpContext } from "../types";

function makeContext(result: { data: unknown[]; error: null }) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    ilike: vi.fn(),
    limit: vi.fn(),
    then: (resolve: (value: typeof result) => unknown) =>
      Promise.resolve(result).then(resolve),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.ilike.mockReturnValue(query);
  query.limit.mockReturnValue(query);

  const from = vi.fn(() => query);
  const context = {
    organizationId: "d31a7319-c347-40f6-96f1-640353a97ae0",
    supabase: { from },
  } as unknown as McpContext;

  return { context, from, query };
}

describe("crm_search_products — catálogo foodservice", () => {
  it("busca no food_products, limita à organização e filtra disponibilidade", async () => {
    const product = {
      id: "product-1",
      name: "Torta de Morango",
      description: "Torta artesanal de morango.",
      price_cents: 1500,
      is_available: true,
      image_url: null,
      sku: "TORTA-MORANGO",
      category_id: "category-1",
    };
    const { context, from, query } = makeContext({ data: [product], error: null });

    const result = await crmSearchProducts.handler(
      { termo: "Morango", limite: 10, somente_disponiveis: true },
      context,
    );

    expect(from).toHaveBeenCalledExactlyOnceWith("food_products");
    expect(query.eq).toHaveBeenCalledWith(
      "organization_id",
      "d31a7319-c347-40f6-96f1-640353a97ae0",
    );
    expect(query.eq).toHaveBeenCalledWith("is_available", true);
    expect(query.ilike).toHaveBeenCalledWith("name", "%Morango%");
    expect(result).toEqual({ produtos: [product] });
  });

  it("não filtra disponibilidade quando solicitada a busca de todos os itens", async () => {
    const { context, from, query } = makeContext({ data: [], error: null });

    await crmSearchProducts.handler(
      { termo: "Morango", limite: 10, somente_disponiveis: false },
      context,
    );

    expect(from).toHaveBeenCalledExactlyOnceWith("food_products");
    expect(query.eq).not.toHaveBeenCalledWith("is_available", true);
    expect(query.ilike).toHaveBeenCalledWith("name", "%Morango%");
  });
});

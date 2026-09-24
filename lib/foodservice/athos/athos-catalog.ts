/**
 * Wrapper read-only do catalogo CRM usado pelo bridge Athos (briefing recovery
 * Athos x Sarah E2E 2026-09-13).
 *
 * FONTE DE LEITURA: a RPC `public.fn_food_public_catalog(p_tenant_slug)`
 * (criada em 0158_food_commerce, estavel em 0175_food_read_functions_stable),
 * sobre as tabelas `food_*` do CRM. Este modulo nao prova sincronizacao com o
 * cardapio externo da Athos; essa equivalencia exige validacao operacional.
 *
 * O catalogo e cacheado em memoria por (org, slug) para evitar chamadas
 * repetidas a RPC dentro do mesmo turno (cada turno pode tocar
 * multiplos itens). TTL de 5 minutos.
 */

import type pg from 'pg';
import { createHash } from 'node:crypto';

export interface AthosCatalogProduct {
  id: string;
  athosProductId: string | null;
  sku?: string | null;
  categoryId: string;
  name: string;
  slug: string;
  priceCents: number;
  description: string | null;
  emoji: string | null;
  modifierGroups: ReadonlyArray<AthosCatalogModifierGroup>;
}

export interface AthosCatalogModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isRequired: boolean;
  modifiers: ReadonlyArray<AthosCatalogModifier>;
}

export interface AthosCatalogModifier {
  id: string;
  name: string;
  priceDeltaCents: number;
}

export interface AthosCatalogCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

export interface AthosCatalog {
  tenantSlug: string;
  tenantDisplayName: string;
  tenantCurrency: string;
  freeShippingThresholdCents: number | null;
  whatsappNumber: string | null;
  categories: ReadonlyArray<AthosCatalogCategory>;
  products: ReadonlyArray<AthosCatalogProduct>;
}

export async function fetchAthosCatalog(
  pool: pg.Pool,
  organizationId: string,
  tenantSlug: string,
): Promise<AthosCatalog> {
  const cacheKey = makeCacheKey(organizationId, tenantSlug);
  const cached = catalogCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const supabase = await getSupabaseServiceClient();
  const { data, error } = await supabase.rpc('fn_food_public_catalog', {
    p_tenant_slug: tenantSlug,
  });
  if (error !== null || data === null) {
    throw new Error(
      `athos_catalog_fetch_failed: ${error?.message ?? 'no data'}`,
    );
  }
  const raw = data as unknown as RawCatalogShape;
  const catalog = normalizeCatalog(tenantSlug, raw);
  const mappings = await pool.query<{
    external_product_id: string;
    athos_product_id: string;
  }>(
    `select external_product_id, athos_product_id::text
       from food_athos_product_map
      where organization_id = $1`,
    [organizationId],
  );
  const byExternalProductId = new Map(
    mappings.rows.map((mapping) => [normalize(mapping.external_product_id), mapping.athos_product_id]),
  );
  catalog.products = catalog.products.map((product) => ({
    ...product,
    athosProductId: byExternalProductId.get(normalize(product.slug)) ?? null,
    // The Athos sandbox contract does not require SKU; the v107 map stores
    // the Athos UUID, not a separate SKU/code.
    sku: null,
  }));
  catalogCache.set(cacheKey, { value: catalog, expiresAt: Date.now() + CACHE_TTL_MS });
  return catalog;
}

export function clearAthosCatalogCache(): void {
  catalogCache.clear();
}

export function resolveAthosCatalogProductByName(
  catalog: AthosCatalog,
  nameQuery: string,
): AthosCatalogProduct | null {
  const normalized = normalize(nameQuery);
  let best: { score: number; product: AthosCatalogProduct } | null = null;
  for (const product of catalog.products) {
    const score = matchScore(normalize(product.name), normalized);
    if (score > 0 && (best === null || score > best.score)) {
      best = { score, product };
    }
  }
  return best === null ? null : best.product;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

const catalogCache = new Map<string, { value: AthosCatalog; expiresAt: number }>();

function makeCacheKey(orgId: string, slug: string): string {
  return createHash('sha256').update(`${orgId}|${slug}`).digest('hex').slice(0, 16);
}

async function getSupabaseServiceClient(): Promise<SupabaseRpcLike> {
  const { createAdminClient } = await import('../../supabase/admin');
  return createAdminClient() as unknown as SupabaseRpcLike;
}

interface SupabaseRpcLike {
  rpc(name: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

interface RawCatalogShape {
  tenant: {
    slug: string;
    display_name: string;
    currency: string;
    free_shipping_threshold_cents: number | null;
    whatsapp_number: string | null;
  };
  categories: Array<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
  }>;
  products: Array<{
    id: string;
    sku?: string | null;
    category_id: string;
    name: string;
    slug: string;
    description: string | null;
    emoji: string | null;
    price_cents: number;
    modifier_groups: Array<{
      id: string;
      name: string;
      min_select: number;
      max_select: number;
      is_required: boolean;
      modifiers: Array<{
        id: string;
        name: string;
        price_delta_cents: number;
      }>;
    }>;
  }>;
}

function normalizeCatalog(tenantSlug: string, raw: RawCatalogShape): AthosCatalog {
  return {
    tenantSlug: raw.tenant.slug ?? tenantSlug,
    tenantDisplayName: raw.tenant.display_name,
    tenantCurrency: raw.tenant.currency,
    freeShippingThresholdCents: raw.tenant.free_shipping_threshold_cents,
    whatsappNumber: raw.tenant.whatsapp_number,
    categories: raw.categories.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
    })),
    products: raw.products.map((p) => ({
      id: p.id,
      athosProductId: null,
      // Athos UUID mapping is loaded from food_athos_product_map after RPC.
      sku: null,
      categoryId: p.category_id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      emoji: p.emoji,
      priceCents: p.price_cents,
      modifierGroups: (p.modifier_groups ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        minSelect: g.min_select,
        maxSelect: g.max_select,
        isRequired: g.is_required,
        modifiers: (g.modifiers ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          priceDeltaCents: m.price_delta_cents,
        })),
      })),
    })),
  };
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function matchScore(productName: string, query: string): number {
  if (productName === query) return 100;
  if (productName.includes(query)) return 60;
  if (query.includes(productName) && productName.length >= 4) return 40;
  const productTokens = productName.split(' ').filter((t) => t.length >= 3);
  for (const token of productTokens) {
    if (query.includes(token)) return 20;
  }
  return 0;
}

/**
 * Detector de selecao de itens para o cart Athos (briefing recovery
 * Athos x Sarah E2E 2026-09-13).
 *
 * Reconhece padroes como:
 *   "quero 2 bolo de chocolate"
 *   "2 bolos de chocolate"
 *   "1 torta de morango e 1 bolo"
 *
 * Resolve cada item contra o catalogo CRM do bridge (athos-catalog.ts) e retorna
 * a lista de AthosCartItem. Itens nao encontrados sao IGNORADOS com aviso -
 * NAO inventamos preco (regra do briefing: preco sempre do catalogo, nunca
 * do LLM).
 */

import type {
  AthosCatalog,
  AthosCatalogProduct,
} from './athos-catalog';
import { resolveAthosCatalogProductByName } from './athos-catalog';
import type { AthosCartItem } from './order-state';

const CART_SELECTION_RE =
  /\b(?:(?:quero|qero|preciso|seria|seriam)\s+)?(\d{1,3})\s+(?:de\s+|x\s+)?([\p{L}\p{N}\s\-']{3,80}?)(?=\s*(?:,|\.|;|e\s+\d|por\s+favor|$|pra\s+\d|brigad|$))(?=\s*(?:,|\.|;|e\s+|$|por favor|$|brigad|$))/giu;

export interface CartSelectionResult {
  matched: boolean;
  items: ReadonlyArray<AthosCartItem>;
  unresolvedNames: ReadonlyArray<string>;
}

export function detectAndResolveCartSelection(
  text: string,
  catalog: AthosCatalog,
): CartSelectionResult {
  const items: AthosCartItem[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CART_SELECTION_RE)) {
    const quantityRaw = match[1] ?? '';
    const nameRaw = match[2] ?? '';
    const quantity = Number.parseInt(quantityRaw, 10);
    const name = nameRaw.trim();
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) continue;
    if (name.length < 3) continue;
    if (seen.has(name.toLocaleLowerCase('pt-BR'))) continue;
    seen.add(name.toLocaleLowerCase('pt-BR'));
    const product = resolveAthosCatalogProductByName(catalog, name);
    if (product === null) {
      unresolved.push(name);
      continue;
    }
    items.push(toCartItem(product, quantity));
  }
  return {
    matched: items.length > 0,
    items,
    unresolvedNames: unresolved,
  };
}

function toCartItem(
  product: AthosCatalogProduct,
  quantity: number,
): AthosCartItem {
  return {
    externalProductId: product.id,
    productName: product.name,
    quantity,
    unitPriceCents: product.priceCents,
    modifiers: [],
  };
}

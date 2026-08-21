"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";

import { randomId } from "@/lib/random-id";

type StorefrontConfig = {
  identity?: string;
  subbrand?: string;
  logo_mode?: "mark" | "wordmark";
  hero_image_url?: string;
  hero_eyebrow?: string;
  quick_cards?: Array<{
    title: string;
    text: string;
  }>;
};

type Tenant = {
  slug: string;
  display_name: string;
  app_name: string;
  tagline: string | null;
  headline: string | null;
  description: string | null;
  logo_url: string | null;
  accent_hex: string;
  accent_soft_hex: string;
  whatsapp_number: string | null;
  free_shipping_threshold_cents: number | null;
  currency: string;
  storefront: StorefrontConfig | null;
};

type Category = {
  id: string;
  name: string;
  slug: string;
  sort_order: number;
  description: string | null;
};

type Product = {
  id: string;
  sku: string | null;
  name: string;
  slug: string;
  emoji: string | null;
  image_url: string | null;
  sort_order: number;
  category_id: string;
  description: string | null;
  price_cents: number;
  compare_at_price_cents: number | null;
  modifier_groups: unknown[];
};

type RecommendationRule = {
  id: string;
  kind: "upsell" | "cross_sell" | "upgrade" | "combo" | "order_bump" | "cart_goal";
  name: string;
  benefit: string | null;
  priority: number;
  threshold_cents: number | null;
  trigger_product_id: string | null;
  recommended_product_id: string | null;
};

type Catalog = {
  tenant: Tenant;
  categories: Category[];
  products: Product[];
  recommendation_rules: RecommendationRule[];
};

type CartLine = {
  key: string;
  product: Product;
  quantity: number;
  recommendationRuleId: string | null;
};

type CheckoutResult = {
  order_id: string;
  contact_id: string;
  total_cents: number;
  currency: string;
  status: string;
};

type ApiSuccess<T> = { data: T };
type ApiFailure = { error?: { message?: string } };
type Modal = "upsell" | "cart" | "checkout" | "done" | null;

const HERO_IMAGE =
  "https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=1800&q=88";

function money(cents: number, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

function randomKey() {
  return randomId();
}

export default function FoodStorefrontPage() {
  const params = useParams<{ tenant: string }>();
  const tenantSlug = Array.isArray(params?.tenant) ? params.tenant[0] : params?.tenant;

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [lastAddedProductId, setLastAddedProductId] = useState<string | null>(null);

  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [fulfillment, setFulfillment] = useState<"retirada" | "entrega">("retirada");
  const [paymentMethod, setPaymentMethod] = useState<"pix" | "cartao" | "dinheiro">("pix");
  const [addressNotes, setAddressNotes] = useState("");
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [success, setSuccess] = useState<CheckoutResult | null>(null);

  const sessionKeyRef = useRef("");
  const checkoutKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem("deskcomm-food-session");
    const key = saved && saved.length >= 6 ? saved : randomKey();
    sessionKeyRef.current = key;
    if (!saved) window.localStorage.setItem("deskcomm-food-session", key);
  }, []);

  useEffect(() => {
    if (!tenantSlug) return;
    const controller = new AbortController();

    async function loadCatalog() {
      setLoading(true);
      setLoadError(null);
      try {
        const response = await fetch(`/api/v1/food/${encodeURIComponent(tenantSlug)}`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        const payload = (await response.json()) as ApiSuccess<Catalog> | ApiFailure;
        if (!response.ok || !("data" in payload)) {
          throw new Error(
            "error" in payload && payload.error?.message
              ? payload.error.message
              : "Não foi possível carregar o cardápio.",
          );
        }
        setCatalog(payload.data);
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : "Não foi possível carregar o cardápio.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadCatalog();
    return () => controller.abort();
  }, [tenantSlug]);

  const currency = catalog?.tenant.currency ?? "BRL";
  const wine = catalog?.tenant.accent_hex ?? "#6f2f35";
  const soft = catalog?.tenant.accent_soft_hex ?? "#f1e7da";
  const storefront = catalog?.tenant.storefront ?? {};
const heroImage = storefront.hero_image_url || HERO_IMAGE;
const subbrand = storefront.subbrand || "Padaria & confeitaria";
const logoMode = storefront.logo_mode || "mark";
const heroEyebrow =
  storefront.hero_eyebrow ||
  `${catalog?.tenant.display_name ?? ""} • feito para o seu momento`;

const quickCards =
  storefront.quick_cards?.length === 3
    ? storefront.quick_cards
    : [
        {
          title: "Forno ao longo do dia",
          text: "Pães, salgados e doces sempre frescos.",
        },
        {
          title: "Peça do seu jeito",
          text: "Retirada ou entrega em poucos passos.",
        },
        {
          title: "Boas combinações",
          text: "Sugestões relevantes para completar o pedido.",
        },
      ];

  const productMap = useMemo(
    () => new Map((catalog?.products ?? []).map((product) => [product.id, product])),
    [catalog],
  );

  const categoryMap = useMemo(
    () => new Map((catalog?.categories ?? []).map((category) => [category.id, category])),
    [catalog],
  );

  const subtotal = useMemo(
    () => cart.reduce((sum, line) => sum + line.product.price_cents * line.quantity, 0),
    [cart],
  );

  const itemCount = useMemo(
    () => cart.reduce((sum, line) => sum + line.quantity, 0),
    [cart],
  );

  const recommendedRevenue = useMemo(
    () =>
      cart.reduce(
        (sum, line) =>
          sum + (line.recommendationRuleId ? line.product.price_cents * line.quantity : 0),
        0,
      ),
    [cart],
  );

  const cartProductIds = useMemo(() => new Set(cart.map((line) => line.product.id)), [cart]);

  const cartGoalRule = useMemo(
    () =>
      catalog?.recommendation_rules
        .filter((rule) => rule.kind === "cart_goal" && rule.threshold_cents)
        .sort((a, b) => a.priority - b.priority)[0] ?? null,
    [catalog],
  );

  const goalThreshold =
    cartGoalRule?.threshold_cents ?? catalog?.tenant.free_shipping_threshold_cents ?? null;
  const goalRemaining = goalThreshold ? Math.max(0, goalThreshold - subtotal) : 0;
  const goalProgress = goalThreshold ? Math.min(100, (subtotal / goalThreshold) * 100) : 0;

  const upsellSuggestions = useMemo(() => {
    if (!catalog || !lastAddedProductId) return [];
    return catalog.recommendation_rules
      .filter(
        (rule) =>
          rule.kind !== "cart_goal" &&
          rule.trigger_product_id === lastAddedProductId &&
          rule.recommended_product_id &&
          !cartProductIds.has(rule.recommended_product_id),
      )
      .sort((a, b) => a.priority - b.priority)
      .map((rule) => ({
        rule,
        product: productMap.get(rule.recommended_product_id!),
      }))
      .filter((entry): entry is { rule: RecommendationRule; product: Product } => Boolean(entry.product))
      .slice(0, 2);
  }, [catalog, lastAddedProductId, cartProductIds, productMap]);

  const checkoutSuggestion = (() => {
    if (!catalog || cartProductIds.size === 0) return null;
    const rules = catalog.recommendation_rules
      .filter(
        (rule) =>
          rule.kind !== "cart_goal" &&
          rule.recommended_product_id &&
          !cartProductIds.has(rule.recommended_product_id) &&
          (!rule.trigger_product_id || cartProductIds.has(rule.trigger_product_id)),
      )
      .sort((a, b) => a.priority - b.priority);

    for (const rule of rules) {
      const product = productMap.get(rule.recommended_product_id!);
      if (product) return { rule, product };
    }
    return null;
  })();

  const featured = useMemo(() => {
    if (!catalog) return null;
    const combo = catalog.recommendation_rules
      .filter((rule) => rule.kind === "combo" && rule.recommended_product_id)
      .sort((a, b) => a.priority - b.priority)[0];
    if (combo?.recommended_product_id) {
      const product = productMap.get(combo.recommended_product_id);
      if (product) return { rule: combo, product };
    }
    const product = catalog.products.find((p) => p.image_url) ?? catalog.products[0];
    return product ? { rule: null, product } : null;
  }, [catalog, productMap]);

  const visibleProducts = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLocaleLowerCase("pt-BR");
    return catalog.products.filter((product) => {
      const categoryOk = activeCategory === "all" || product.category_id === activeCategory;
      const searchOk =
        !q ||
        `${product.name} ${product.description ?? ""}`
          .toLocaleLowerCase("pt-BR")
          .includes(q);
      return categoryOk && searchOk;
    });
  }, [catalog, activeCategory, query]);

  function resetCheckoutState() {
    checkoutKeyRef.current = null;
    setCheckoutError(null);
    setSuccess(null);
  }

  function addProduct(
    product: Product,
    recommendationRuleId: string | null = null,
    showContextualUpsell = false,
  ) {
    resetCheckoutState();
    const key = `${product.id}:${recommendationRuleId ?? "direct"}`;

    setCart((current) => {
      const found = current.find((line) => line.key === key);
      if (found) {
        return current.map((line) =>
          line.key === key ? { ...line, quantity: Math.min(99, line.quantity + 1) } : line,
        );
      }
      return [...current, { key, product, quantity: 1, recommendationRuleId }];
    });

    if (showContextualUpsell) {
      setLastAddedProductId(product.id);
      window.setTimeout(() => setModal("upsell"), 0);
    }
  }

  function changeQuantity(key: string, delta: number) {
    resetCheckoutState();
    setCart((current) =>
      current
        .map((line) =>
          line.key === key
            ? { ...line, quantity: Math.max(0, Math.min(99, line.quantity + delta)) }
            : line,
        )
        .filter((line) => line.quantity > 0),
    );
  }

  async function submitOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantSlug || cart.length === 0 || submitting) return;

    setSubmitting(true);
    setCheckoutError(null);

    if (!sessionKeyRef.current) {
      sessionKeyRef.current = randomKey();
      window.localStorage.setItem("deskcomm-food-session", sessionKeyRef.current);
    }
    if (!checkoutKeyRef.current) checkoutKeyRef.current = randomKey();

    try {
      const response = await fetch(`/api/v1/food/${encodeURIComponent(tenantSlug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          idempotency_key: checkoutKeyRef.current,
          session_key: sessionKeyRef.current,
          customer_name: customerName,
          phone,
          fulfillment,
          payment_method: paymentMethod,
          address_notes: fulfillment === "entrega" ? addressNotes : "",
          marketing_consent: marketingConsent,
          items: cart.map((line) => ({
            product_id: line.product.id,
            quantity: line.quantity,
            modifier_ids: [],
            recommendation_rule_id: line.recommendationRuleId,
          })),
        }),
      });

      const payload = (await response.json()) as ApiSuccess<CheckoutResult> | ApiFailure;
      if (!response.ok || !("data" in payload)) {
        throw new Error(
          "error" in payload && payload.error?.message
            ? payload.error.message
            : "Não foi possível concluir o pedido.",
        );
      }

      setSuccess(payload.data);
      setCart([]);
      checkoutKeyRef.current = null;
      setModal("done");
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Não foi possível concluir o pedido.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="food-root">
        <style>{styles}</style>
        <div className="loading-shell">
          <div className="loading-brand" />
          <div className="loading-hero" />
          <div className="loading-grid">
            {Array.from({ length: 6 }).map((_, i) => <div className="loading-card" key={i} />)}
          </div>
        </div>
      </main>
    );
  }

  if (loadError || !catalog) {
    return (
      <main className="food-root">
        <style>{styles}</style>
        <div className="error-state">
          <div className="error-box">
            <div className="error-icon">🍽️</div>
            <h1>Cardápio indisponível</h1>
            <p>{loadError ?? "Tente novamente em instantes."}</p>
            <button onClick={() => window.location.reload()}>Tentar novamente</button>
          </div>
        </div>
      </main>
    );
  }

  const heroTitle = catalog.tenant.tagline || "Do forno para bons momentos.";
  const heroText =
    catalog.tenant.description ||
    "Escolha seus favoritos, monte seu pedido e descubra combinações pensadas para deixar sua experiência ainda melhor.";

  return (
    <main
      className="food-root"
      style={
        {
          "--wine": wine,
          "--wine-soft": soft,
        } as React.CSSProperties
      }
    >
      <style>{styles}</style>

      <div className="store-wrap">
        <header className="food-header">
          <div className={`logo ${logoMode === "wordmark" ? "logo-wordmark" : ""}`}>
  {catalog.tenant.logo_url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`logo-image ${logoMode === "wordmark" ? "logo-image-wordmark" : ""}`}
      src={catalog.tenant.logo_url}
      alt={catalog.tenant.app_name}
    />
  ) : (
    <div className="mark">{catalog.tenant.app_name.slice(0, 1).toUpperCase()}</div>
  )}

  {logoMode !== "wordmark" ? (
    <div>
      <div className="brand">{catalog.tenant.display_name || catalog.tenant.app_name}</div>
      <div className="subbrand">{subbrand}</div>
    </div>
  ) : null}
</div>

          <div className="head-actions">
            <button
              className="ghost"
              type="button"
              onClick={() => document.querySelector("#menu")?.scrollIntoView({ behavior: "smooth" })}
            >
              Cardápio
            </button>
          </div>
        </header>

        <section
          className="hero"
          style={{
            backgroundImage: `linear-gradient(90deg,rgba(20,16,10,.80),rgba(20,16,10,.20)),url('${heroImage}')`,
          }}
        >
          <div className="hero-content">
            <div className="eyebrow">{heroEyebrow}</div>
            <h1>{heroTitle}</h1>
            <p>{heroText}</p>
            <div className="hero-cta">
              <button
                className="primary"
                type="button"
                onClick={() => document.querySelector("#menu")?.scrollIntoView({ behavior: "smooth" })}
              >
                Ver cardápio
              </button>
              <span className="light">Retirada ou entrega</span>
            </div>
          </div>
        </section>

        <div className="quick">
  {quickCards.map((card) => (
    <div className="quick-card" key={card.title}>
      <strong>{card.title}</strong>
      <small>{card.text}</small>
    </div>
  ))}
</div>

        <section id="menu">
          <div className="section-head">
            <div>
              <div className="eyebrow wine-text">Cardápio</div>
              <h2>Escolha o seu momento</h2>
              <p>{catalog.tenant.headline || "Escolha seus favoritos e monte seu pedido."}</p>
            </div>
            <input
              className="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar no cardápio"
              aria-label="Buscar no cardápio"
            />
          </div>

          <div className="cats">
            <button
              className={`cat ${activeCategory === "all" ? "active" : ""}`}
              onClick={() => setActiveCategory("all")}
              type="button"
            >
              Todos
            </button>
            {catalog.categories.map((category) => (
              <button
                key={category.id}
                className={`cat ${activeCategory === category.id ? "active" : ""}`}
                onClick={() => setActiveCategory(category.id)}
                type="button"
              >
                {category.name}
              </button>
            ))}
          </div>

          {featured ? (
            <div className="combo-strip">
              <div>
                <div className="eyebrow wine-text">Sugestão {catalog.tenant.display_name}</div>
                <strong>{featured.product.name}</strong>
                <p>
                  {featured.rule?.benefit ||
                    featured.product.description ||
                    "Uma escolha que combina com diferentes momentos do dia."}{" "}
                  <b>{money(featured.product.price_cents, currency)}</b>
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  addProduct(featured.product, featured.rule?.id ?? null, false)
                }
              >
                Adicionar
              </button>
            </div>
          ) : null}

          <div className="products">
            {visibleProducts.map((product) => {
              const category = categoryMap.get(product.category_id);
              return (
                <article className="product" key={product.id}>
                  <div
                    className={`photo ${product.image_url ? "" : "photo-fallback"}`}
                    style={
                      product.image_url
                        ? { backgroundImage: `url('${product.image_url}')` }
                        : undefined
                    }
                  >
                    {!product.image_url ? <span className="fallback-emoji">{product.emoji ?? "🍽️"}</span> : null}
                    <span className="badge">{category?.name ?? catalog.tenant.display_name}</span>
                  </div>
                  <div className="pbody">
                    <h3>{product.name}</h3>
                    <div className="desc">{product.description || "Preparado com cuidado para o seu momento."}</div>
                    <div className="prow">
                      <span className="price">{money(product.price_cents, currency)}</span>
                      <button
                        className="add"
                        aria-label={`Adicionar ${product.name}`}
                        type="button"
                        onClick={() => addProduct(product, null, true)}
                      >
                        +
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {visibleProducts.length === 0 ? (
            <div className="empty-search">Nenhum item encontrado nesta seleção.</div>
          ) : null}
        </section>
      </div>

      <div className={`cartbar ${itemCount === 0 ? "empty" : ""}`}>
        <div className="cartmeta">
          <strong>
            {itemCount} {itemCount === 1 ? "item" : "itens"} no pedido
          </strong>
          <small>
            Total {money(subtotal, currency)}
            {recommendedRevenue > 0 ? ` • ${money(recommendedRevenue, currency)} vieram de sugestões` : ""}
          </small>
        </div>
        <button className="cartbtn" type="button" onClick={() => setModal("cart")}>
          Ver pedido
        </button>
      </div>

      {modal === "upsell" && upsellSuggestions.length > 0 ? (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="sheet">
            <div className="sheet-top">
              <div>
                <div className="eyebrow wine-text">Uma boa combinação</div>
                <h2>Que tal completar o pedido?</h2>
                <div className="lead">
                  Algumas escolhas combinam especialmente bem com o item que você acabou de adicionar.
                </div>
              </div>
              <button className="close" type="button" onClick={() => setModal(null)}>×</button>
            </div>

            <div className="reco">
              {upsellSuggestions.map(({ rule, product }) => (
                <div className="reco-card" key={rule.id}>
                  <div
                    className={`reco-img ${product.image_url ? "" : "photo-fallback"}`}
                    style={product.image_url ? { backgroundImage: `url('${product.image_url}')` } : undefined}
                  >
                    {!product.image_url ? <span className="fallback-emoji small">{product.emoji ?? "🍽️"}</span> : null}
                  </div>
                  <div className="reco-body">
                    <strong>{product.name}</strong>
                    <small>+ {money(product.price_cents, currency)}</small>
                    <button
                      className="reco-add"
                      type="button"
                      onClick={() => {
                        addProduct(product, rule.id, false);
                        setModal(null);
                      }}
                    >
                      Adicionar ao pedido
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button className="secondary" type="button" onClick={() => setModal(null)}>
              Continuar sem adicionar
            </button>
          </div>
        </div>
      ) : null}

      {modal === "upsell" && upsellSuggestions.length === 0 ? (
        <NoSuggestions onClose={() => setModal(null)} onOpenCart={() => setModal("cart")} />
      ) : null}

      {modal === "cart" ? (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="sheet">
            <div className="sheet-top">
              <div>
                <div className="eyebrow wine-text">Seu pedido</div>
                <h2>{itemCount > 0 ? "Está quase pronto." : "Seu carrinho está vazio."}</h2>
              </div>
              <button className="close" type="button" onClick={() => setModal(null)}>×</button>
            </div>

            {goalThreshold && itemCount > 0 ? (
              <div className="goal">
                <div className="goal-top">
                  <span>Meta promocional</span>
                  <span>{Math.round(goalProgress)}%</span>
                </div>
                <div className="progress">
                  <span style={{ width: `${goalProgress}%` }} />
                </div>
                <small>
                  {goalRemaining > 0
                    ? `Faltam ${money(goalRemaining, currency)} para atingir a meta do pedido.`
                    : "Você atingiu a meta promocional deste pedido."}
                </small>
              </div>
            ) : null}

            <div className="cartlist">
              {cart.map((line) => (
                <div className="ci" key={line.key}>
                  <div
                    className={`ci-img ${line.product.image_url ? "" : "photo-fallback"}`}
                    style={
                      line.product.image_url
                        ? { backgroundImage: `url('${line.product.image_url}')` }
                        : undefined
                    }
                  >
                    {!line.product.image_url ? <span className="fallback-emoji tiny-emoji">{line.product.emoji ?? "🍽️"}</span> : null}
                  </div>
                  <div>
                    <h4>{line.product.name}</h4>
                    <small>
                      {money(line.product.price_cents, currency)} cada
                      {line.recommendationRuleId ? " • sugerido pelo sistema" : ""}
                    </small>
                  </div>
                  <div className="qty">
                    <button type="button" onClick={() => changeQuantity(line.key, -1)}>−</button>
                    <b>{line.quantity}</b>
                    <button type="button" onClick={() => changeQuantity(line.key, 1)}>+</button>
                  </div>
                </div>
              ))}
            </div>

            {checkoutSuggestion && itemCount > 0 ? (
              <div className="mini-offer">
                <div
                  className={`thumb ${checkoutSuggestion.product.image_url ? "" : "photo-fallback"}`}
                  style={
                    checkoutSuggestion.product.image_url
                      ? { backgroundImage: `url('${checkoutSuggestion.product.image_url}')` }
                      : undefined
                  }
                >
                  {!checkoutSuggestion.product.image_url ? (
                    <span className="fallback-emoji tiny-emoji">
                      {checkoutSuggestion.product.emoji ?? "🍽️"}
                    </span>
                  ) : null}
                </div>
                <div>
                  <strong>Que tal incluir {checkoutSuggestion.product.name.toLowerCase()}?</strong>
                  <small>{checkoutSuggestion.rule.benefit || "Uma última boa combinação antes do checkout."}</small>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    addProduct(
                      checkoutSuggestion.product,
                      checkoutSuggestion.rule.id,
                      false,
                    )
                  }
                >
                  + {money(checkoutSuggestion.product.price_cents, currency)}
                </button>
              </div>
            ) : null}

            <div className="summary">
              <div className="sumrow">
                <span>Subtotal</span>
                <b>{money(subtotal, currency)}</b>
              </div>
              {recommendedRevenue > 0 ? (
                <div className="sumrow">
                  <span>Itens adicionados por sugestões</span>
                  <b className="green">+ {money(recommendedRevenue, currency)}</b>
                </div>
              ) : null}
              <div className="sumrow total">
                <span>Total</span>
                <span>{money(subtotal, currency)}</span>
              </div>
            </div>

            <button
              className="full"
              type="button"
              disabled={itemCount === 0}
              onClick={() => setModal("checkout")}
            >
              Continuar para checkout
            </button>
          </div>
        </div>
      ) : null}

      {modal === "checkout" ? (
        <div className="overlay">
          <form className="sheet" onSubmit={submitOrder}>
            <div className="sheet-top">
              <div>
                <div className="eyebrow wine-text">Checkout</div>
                <h2>Como você quer receber?</h2>
                <div className="lead">Preencha os dados para concluir seu pedido.</div>
              </div>
              <button className="close" type="button" onClick={() => setModal("cart")}>×</button>
            </div>

            <div className="cols">
              <div className="field">
                <label htmlFor="co-name">Seu nome</label>
                <input
                  id="co-name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Nome"
                  required
                  maxLength={160}
                />
              </div>
              <div className="field">
                <label htmlFor="co-phone">WhatsApp</label>
                <input
                  id="co-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(12) 99999-9999"
                  required
                />
              </div>
            </div>

            <div className="cols">
              <div className="field">
                <label htmlFor="co-mode">Recebimento</label>
                <select
                  id="co-mode"
                  value={fulfillment}
                  onChange={(e) => setFulfillment(e.target.value as "retirada" | "entrega")}
                >
                  <option value="retirada">Retirar no estabelecimento</option>
                  <option value="entrega">Receber em casa</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="co-pay">Pagamento</label>
                <select
                  id="co-pay"
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as "pix" | "cartao" | "dinheiro")}
                >
                  <option value="pix">Pix</option>
                  <option value="cartao">Cartão</option>
                  <option value="dinheiro">Dinheiro</option>
                </select>
              </div>
            </div>

            {fulfillment === "entrega" ? (
              <div className="field">
                <label htmlFor="co-address">Endereço de entrega</label>
                <textarea
                  id="co-address"
                  rows={3}
                  value={addressNotes}
                  onChange={(e) => setAddressNotes(e.target.value)}
                  placeholder="Rua, número, bairro, complemento e referência"
                  required
                />
              </div>
            ) : null}

            <label className="consent">
              <input
                type="checkbox"
                checked={marketingConsent}
                onChange={(e) => setMarketingConsent(e.target.checked)}
              />
              <span>
                Quero receber promoções, ofertas e novidades da {catalog.tenant.display_name} pelo WhatsApp.
                Posso cancelar quando quiser.
              </span>
            </label>

            <div className="summary">
              <div className="sumrow total">
                <span>Total do pedido</span>
                <span>{money(subtotal, currency)}</span>
              </div>
            </div>

            {checkoutError ? <div className="checkout-error">{checkoutError}</div> : null}

            <button className="full" type="submit" disabled={submitting || itemCount === 0}>
              {submitting ? "Enviando pedido..." : "Confirmar pedido"}
            </button>
            <button className="secondary" type="button" onClick={() => setModal("cart")}>
              Voltar ao pedido
            </button>
          </form>
        </div>
      ) : null}

      {modal === "done" && success ? (
        <div className="overlay">
          <div className="sheet done-sheet">
            <div className="done-icon">✓</div>
            <div className="eyebrow wine-text">Pedido recebido</div>
            <h2>Perfeito. Agora é com a {catalog.tenant.display_name}.</h2>
            <div className="lead">
              Seu pedido foi registrado com sucesso. Número: <b>{success.order_id.slice(0, 8).toUpperCase()}</b>
            </div>
            <div className="order-total">{money(success.total_cents, success.currency)}</div>
            <button
              className="full"
              type="button"
              onClick={() => {
                setSuccess(null);
                setModal(null);
              }}
            >
              Voltar ao cardápio
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function NoSuggestions({ onClose }: {
  onClose: () => void;
  onOpenCart: () => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 0);
    return () => window.clearTimeout(timer);
  }, [onClose]);

  return null;
}

const styles = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600&display=swap');
.food-root{
  --ink:#261b15;--muted:#75675f;--paper:#fbf7f0;--card:#fffdf9;
  --wine:#6f2f35;--wine-soft:#f1e7da;--wine2:#8f454b;--line:#e9dfd2;
  --green:#33704c;--shadow:0 18px 50px rgba(55,37,25,.12);
  min-height:100vh;background:var(--paper);color:var(--ink);font-family:'DM Sans',sans-serif
}
.food-root *{box-sizing:border-box}
.food-root button,.food-root input,.food-root textarea,.food-root select{font:inherit}
.food-root button{cursor:pointer}
.store-wrap{max-width:1180px;margin:auto;padding:0 22px 120px}
.food-header{height:82px;display:flex;align-items:center;justify-content:space-between;gap:18px}
.logo{display:flex;align-items:center;gap:12px}
.mark{width:40px;height:40px;border:1px solid color-mix(in srgb,var(--wine) 30%,transparent);border-radius:50%;display:grid;place-items:center;color:var(--wine);font-family:'Playfair Display',serif;font-size:18px;font-weight:700;background:#fff}
.logo-image{width:40px;height:40px;border:1px solid color-mix(in srgb,var(--wine) 30%,transparent);border-radius:50%;background:#fff;object-fit:cover}
.logo-wordmark{min-width:0}
.logo-image-wordmark{width:250px;height:64px;max-width:38vw;border:0;border-radius:0;background:transparent;object-fit:contain;object-position:left center}.brand{font-family:'Playfair Display',serif;font-size:30px;line-height:1;color:var(--wine)}
.subbrand{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-top:3px}
.head-actions{display:flex;align-items:center;gap:9px}
.ghost{border:1px solid var(--line);background:rgba(255,255,255,.78);border-radius:999px;padding:10px 14px;color:var(--ink)}
.hero{height:410px;border-radius:34px;overflow:hidden;position:relative;background-position:center;background-size:cover;box-shadow:var(--shadow)}
.hero-content{height:100%;max-width:630px;padding:54px;display:flex;flex-direction:column;justify-content:center;color:white}
.eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:700;opacity:.86}
.wine-text{color:var(--wine);opacity:1}
.hero h1{font-family:'Playfair Display',serif;font-size:58px;line-height:1.02;margin:10px 0 14px;letter-spacing:-.02em}
.hero p{font-size:17px;line-height:1.55;max-width:540px;color:rgba(255,255,255,.9)}
.hero-cta{display:flex;align-items:center;gap:10px;margin-top:19px}
.primary{border:0;background:var(--wine);color:white;border-radius:999px;padding:13px 18px;font-weight:700;box-shadow:0 10px 25px color-mix(in srgb,var(--wine) 22%,transparent)}
.primary:hover{filter:brightness(1.08)}
.light{border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.12);color:white;border-radius:999px;padding:13px 18px;font-weight:600;backdrop-filter:blur(10px)}
.quick{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:-28px;position:relative;padding:0 28px}
.quick-card{background:rgba(255,253,249,.96);backdrop-filter:blur(12px);border:1px solid rgba(233,223,210,.9);border-radius:20px;padding:18px 20px;box-shadow:0 12px 32px rgba(55,37,25,.08)}
.quick-card strong{display:block;font-size:14px}
.quick-card small{color:var(--muted);font-size:12px}
.section-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin:56px 0 18px}
.section-head h2{font-family:'Playfair Display',serif;font-size:36px;margin:0}
.section-head p{margin:5px 0 0;color:var(--muted);font-size:14px}
.search{min-width:280px;border:1px solid var(--line);background:white;border-radius:999px;padding:12px 16px;outline:none}
.search:focus{border-color:var(--wine);box-shadow:0 0 0 3px color-mix(in srgb,var(--wine) 10%,transparent)}
.cats{display:flex;gap:9px;overflow:auto;padding:13px 0 12px;scrollbar-width:none;position:sticky;top:0;z-index:6;background:linear-gradient(var(--paper) 85%,rgba(251,247,240,0))}
.cats::-webkit-scrollbar{display:none}
.cat{white-space:nowrap;border:1px solid var(--line);background:#fff;border-radius:999px;padding:10px 15px;color:#5f5149}
.cat.active{background:var(--ink);color:white;border-color:var(--ink)}
.products{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.product{background:var(--card);border:1px solid var(--line);border-radius:24px;overflow:hidden;transition:.2s ease;box-shadow:0 7px 18px rgba(55,37,25,.045)}
.product:hover{transform:translateY(-3px);box-shadow:0 16px 34px rgba(55,37,25,.09)}
.photo{height:220px;background-size:cover;background-position:center;position:relative}
.photo-fallback{background:linear-gradient(135deg,var(--wine-soft),#fff9ef);display:grid;place-items:center}
.fallback-emoji{font-size:64px;filter:drop-shadow(0 10px 18px rgba(55,37,25,.12))}
.fallback-emoji.small{font-size:46px}
.fallback-emoji.tiny-emoji{font-size:30px}
.badge{position:absolute;left:12px;top:12px;background:rgba(255,255,255,.9);backdrop-filter:blur(8px);border-radius:999px;padding:7px 10px;font-size:11px;font-weight:700;color:var(--wine)}
.pbody{padding:18px}
.pbody h3{font-family:'Playfair Display',serif;font-size:22px;margin:0 0 7px}
.desc{font-size:13px;line-height:1.48;color:var(--muted);min-height:39px}
.prow{display:flex;align-items:center;justify-content:space-between;margin-top:16px}
.price{font-size:18px;font-weight:700}
.add{width:38px;height:38px;border-radius:50%;border:0;background:var(--wine);color:white;font-size:22px;line-height:1}
.combo-strip{margin:24px 0 4px;padding:18px;border:1px solid var(--line);background:linear-gradient(135deg,#fff9ef,#f7eee1);border-radius:22px;display:grid;grid-template-columns:1fr auto;align-items:center;gap:14px}
.combo-strip strong{font-family:'Playfair Display',serif;font-size:22px}
.combo-strip p{margin:5px 0 0;color:var(--muted);font-size:13px}
.combo-strip button{border:0;background:var(--ink);color:white;border-radius:999px;padding:11px 15px;font-weight:700}
.empty-search{padding:50px 20px;text-align:center;color:var(--muted)}
.cartbar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);width:min(760px,calc(100% - 26px));background:#201711;color:white;border-radius:20px;padding:13px 15px 13px 18px;display:flex;align-items:center;justify-content:space-between;gap:16px;box-shadow:0 18px 50px rgba(0,0,0,.28);z-index:30;transition:.2s}
.cartbar.empty{opacity:0;pointer-events:none;transform:translate(-50%,20px)}
.cartmeta strong{font-size:14px}
.cartmeta small{display:block;color:#cdbfb5;margin-top:2px}
.cartbtn{border:0;background:white;color:var(--ink);border-radius:14px;padding:12px 16px;font-weight:700}
.overlay{position:fixed;inset:0;background:rgba(24,16,12,.55);backdrop-filter:blur(5px);z-index:50;display:flex;align-items:flex-end;justify-content:center}
.sheet{width:min(760px,100%);max-height:92vh;overflow:auto;background:var(--card);border-radius:28px 28px 0 0;padding:24px;box-shadow:0 -18px 50px rgba(0,0,0,.18)}
.sheet-top{display:flex;justify-content:space-between;gap:15px;align-items:flex-start}
.close{width:36px;height:36px;border:1px solid var(--line);background:white;border-radius:50%;font-size:20px}
.sheet h2{font-family:'Playfair Display',serif;font-size:30px;margin:2px 0 8px}
.sheet .lead{color:var(--muted);font-size:14px;line-height:1.5}
.reco{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}
.reco-card{border:1px solid var(--line);border-radius:18px;overflow:hidden;background:white}
.reco-img{height:120px;background-size:cover;background-position:center;display:grid;place-items:center}
.reco-body{padding:12px}
.reco-body strong{font-size:14px;display:block}
.reco-body small{color:var(--muted)}
.reco-add{margin-top:9px;width:100%;border:0;background:#f3ece4;border-radius:10px;padding:9px;font-weight:700;color:var(--wine)}
.cartlist{margin-top:14px}
.ci{display:grid;grid-template-columns:64px 1fr auto;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);align-items:center}
.ci-img{width:64px;height:64px;border-radius:14px;background-size:cover;background-position:center;display:grid;place-items:center}
.ci h4{margin:0 0 3px}
.ci small{color:var(--muted)}
.qty{display:flex;align-items:center;gap:8px}
.qty button{width:28px;height:28px;border-radius:8px;border:1px solid var(--line);background:white}
.summary{margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}
.sumrow{display:flex;justify-content:space-between;margin:9px 0}
.sumrow.total{font-size:20px;font-weight:700}
.green{color:var(--green)}
.full{width:100%;border:0;background:var(--wine);color:white;border-radius:14px;padding:14px;font-weight:700;margin-top:12px}
.full:disabled{opacity:.45;cursor:not-allowed}
.secondary{width:100%;border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:14px;padding:12px;font-weight:700;margin-top:8px}
.goal{background:#f6efe5;border:1px solid #eadfce;border-radius:16px;padding:14px;margin:15px 0}
.goal-top{display:flex;justify-content:space-between;font-size:12px;font-weight:700}
.goal small{display:block;color:var(--muted);margin-top:5px}
.progress{height:7px;background:#e5d7c6;border-radius:999px;overflow:hidden;margin-top:10px}
.progress>span{display:block;height:100%;background:var(--wine);border-radius:999px}
.mini-offer{display:grid;grid-template-columns:64px 1fr auto;gap:10px;align-items:center;border:1px solid var(--line);border-radius:14px;padding:10px;margin-top:12px}
.mini-offer .thumb{width:64px;height:58px;border-radius:11px;background-size:cover;background-position:center;display:grid;place-items:center}
.mini-offer strong{display:block;font-size:13px}
.mini-offer small{color:var(--muted)}
.mini-offer button{border:0;background:var(--wine-soft);color:var(--wine);border-radius:10px;padding:9px;font-weight:700}
.field{display:grid;gap:6px;margin:12px 0}
.field label{font-size:12px;font-weight:700;color:#5e4d43}
.field input,.field textarea,.field select{border:1px solid var(--line);background:white;border-radius:12px;padding:12px;outline:none;width:100%}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.consent{display:flex;gap:10px;background:#f4ede4;border-radius:13px;padding:12px;font-size:12px;line-height:1.45;color:#5d4b41;margin-top:12px}
.checkout-error{margin-top:12px;border:1px solid #efc7c7;background:#fff3f3;color:#8f3030;border-radius:12px;padding:11px 12px;font-size:13px}
.done-sheet{text-align:center;padding-top:34px}
.done-icon{width:58px;height:58px;border-radius:50%;background:#e8f4eb;color:var(--green);display:grid;place-items:center;font-weight:700;font-size:28px;margin:0 auto 18px}
.order-total{font-family:'Playfair Display',serif;font-size:32px;margin:20px 0 5px}
.error-state{min-height:100vh;display:grid;place-items:center;padding:24px}
.error-box{max-width:440px;background:white;border:1px solid var(--line);border-radius:24px;padding:30px;text-align:center}
.error-box h1{font-family:'Playfair Display',serif}
.error-box p{color:var(--muted)}
.error-box button{border:0;background:var(--wine);color:white;border-radius:999px;padding:12px 18px;font-weight:700}
.error-icon{font-size:42px}
.loading-shell{max-width:1180px;margin:auto;padding:28px 22px}
.loading-brand,.loading-hero,.loading-card{background:linear-gradient(90deg,#efe8df,#f7f2eb,#efe8df);background-size:200% 100%;animation:foodPulse 1.4s linear infinite}
.loading-brand{width:180px;height:34px;border-radius:12px}
.loading-hero{height:410px;border-radius:34px;margin-top:28px}
.loading-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:42px}
.loading-card{height:340px;border-radius:24px}
@keyframes foodPulse{to{background-position:-200% 0}}
@media(max-width:900px){
  .products{grid-template-columns:repeat(2,1fr)}
  .hero{height:380px}.hero h1{font-size:48px}
  .quick{grid-template-columns:repeat(3,1fr);padding:0 12px}
  .loading-grid{grid-template-columns:repeat(2,1fr)}
}
@media(max-width:620px){
  .store-wrap{padding:0 14px 110px}
  .food-header{height:70px}.brand{font-size:26px}
  .logo-image-wordmark{width:190px;height:52px;max-width:62vw}
  .hero{height:360px;border-radius:24px;background-position:57% center}
  .hero-content{padding:28px}.hero h1{font-size:42px;max-width:330px}
  .hero p{font-size:15px;max-width:330px}.hero-cta .light{display:none}
  .quick{margin-top:-20px;grid-template-columns:1fr;gap:8px}
  .quick-card{padding:13px 15px}
  .section-head{align-items:flex-start;flex-direction:column;margin-top:40px}
  .section-head h2{font-size:31px}.search{width:100%;min-width:0}
  .products{grid-template-columns:1fr;gap:13px}
  .product{display:grid;grid-template-columns:124px 1fr;border-radius:18px}
  .photo{height:100%;min-height:148px}
  .badge{font-size:9px;left:7px;top:7px}
  .pbody{padding:14px}.pbody h3{font-size:19px}.desc{min-height:0;font-size:12px}
  .prow{margin-top:12px}.price{font-size:16px}.add{width:34px;height:34px}
  .reco{grid-template-columns:1fr}.sheet{padding:20px 16px}
  .cols{grid-template-columns:1fr}.combo-strip{grid-template-columns:1fr}
  .mini-offer{grid-template-columns:54px 1fr}.mini-offer button{grid-column:1/-1;width:100%}
  .loading-grid{grid-template-columns:1fr}.loading-hero{height:360px}
}
`;


"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";

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

function money(cents: number, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

function randomKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export default function FoodStorefrontPage() {
  const params = useParams<{ tenant: string }>();
  const tenantSlug = Array.isArray(params?.tenant) ? params.tenant[0] : params?.tenant;

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);

  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [fulfillment, setFulfillment] = useState<"retirada" | "entrega">("retirada");
  const [paymentMethod, setPaymentMethod] = useState<"pix" | "cartao" | "dinheiro">("pix");
  const [addressNotes, setAddressNotes] = useState("");
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [success, setSuccess] = useState<CheckoutResult | null>(null);

  const sessionKeyRef = useRef<string>("");
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
        if (controller.signal.aborted) return;
        setLoadError(error instanceof Error ? error.message : "Não foi possível carregar o cardápio.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadCatalog();
    return () => controller.abort();
  }, [tenantSlug]);

  const accent = catalog?.tenant.accent_hex ?? "#6B5F33";
  const accentSoft = catalog?.tenant.accent_soft_hex ?? "#EFE7D5";
  const currency = catalog?.tenant.currency ?? "BRL";

  const productsById = useMemo(
    () => new Map((catalog?.products ?? []).map((product) => [product.id, product])),
    [catalog],
  );

  const cartProductIds = useMemo(() => new Set(cart.map((line) => line.product.id)), [cart]);

  const subtotal = useMemo(
    () => cart.reduce((sum, line) => sum + line.product.price_cents * line.quantity, 0),
    [cart],
  );

  const itemCount = useMemo(
    () => cart.reduce((sum, line) => sum + line.quantity, 0),
    [cart],
  );

  const cartGoal = useMemo(
    () =>
      catalog?.recommendation_rules
        .filter((rule) => rule.kind === "cart_goal" && rule.threshold_cents)
        .sort((a, b) => a.priority - b.priority)[0] ?? null,
    [catalog],
  );

  const suggestions = useMemo(() => {
    if (!catalog || cart.length === 0) return [];

    return catalog.recommendation_rules
      .filter(
        (rule) =>
          rule.kind !== "cart_goal" &&
          rule.trigger_product_id &&
          cartProductIds.has(rule.trigger_product_id) &&
          rule.recommended_product_id &&
          !cartProductIds.has(rule.recommended_product_id),
      )
      .sort((a, b) => a.priority - b.priority)
      .map((rule) => ({
        rule,
        product: productsById.get(rule.recommended_product_id!),
      }))
      .filter((entry): entry is { rule: RecommendationRule; product: Product } => Boolean(entry.product))
      .filter(
        (entry, index, array) =>
          array.findIndex((other) => other.product.id === entry.product.id) === index,
      )
      .slice(0, 3);
  }, [catalog, cart, cartProductIds, productsById]);

  const visibleProducts = useMemo(() => {
    if (!catalog) return [];
    if (activeCategory === "all") return catalog.products;
    return catalog.products.filter((product) => product.category_id === activeCategory);
  }, [catalog, activeCategory]);

  function invalidateCheckoutKey() {
    checkoutKeyRef.current = null;
    setCheckoutError(null);
    setSuccess(null);
  }

  function addProduct(product: Product, recommendationRuleId: string | null = null) {
    invalidateCheckoutKey();
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
    setCartOpen(true);
  }

  function changeQuantity(key: string, delta: number) {
    invalidateCheckoutKey();
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
      setCartOpen(true);
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Não foi possível concluir o pedido.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[#faf8f4] px-4 py-16 text-[#28251f]">
        <div className="mx-auto max-w-6xl animate-pulse">
          <div className="h-7 w-44 rounded-full bg-black/10" />
          <div className="mt-5 h-14 max-w-2xl rounded-2xl bg-black/10" />
          <div className="mt-3 h-6 max-w-xl rounded-xl bg-black/10" />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-52 rounded-3xl bg-black/10" />
            ))}
          </div>
        </div>
      </main>
    );
  }

  if (loadError || !catalog) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#faf8f4] px-4 text-[#28251f]">
        <div className="max-w-md rounded-3xl border border-black/10 bg-white p-8 text-center shadow-sm">
          <div className="text-4xl">🍽️</div>
          <h1 className="mt-4 text-2xl font-bold">Cardápio indisponível</h1>
          <p className="mt-2 text-sm text-black/60">{loadError ?? "Tente novamente em instantes."}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 rounded-full bg-black px-5 py-3 text-sm font-bold text-white"
          >
            Tentar novamente
          </button>
        </div>
      </main>
    );
  }

  const goalThreshold = cartGoal?.threshold_cents ?? catalog.tenant.free_shipping_threshold_cents;
  const goalRemaining = goalThreshold ? Math.max(0, goalThreshold - subtotal) : 0;
  const goalProgress = goalThreshold ? Math.min(100, (subtotal / goalThreshold) * 100) : 0;

  return (
    <main
      className="min-h-screen bg-[#faf8f4] text-[#28251f]"
      style={
        {
          "--food-accent": accent,
          "--food-accent-soft": accentSoft,
        } as React.CSSProperties
      }
    >
      <header className="border-b border-black/5 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {catalog.tenant.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={catalog.tenant.logo_url}
                alt={catalog.tenant.app_name}
                className="h-11 w-11 rounded-2xl object-cover"
              />
            ) : (
              <div
                className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-xl font-bold text-white"
                style={{ backgroundColor: accent }}
              >
                {catalog.tenant.app_name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate font-bold">{catalog.tenant.app_name}</p>
              {catalog.tenant.tagline ? (
                <p className="truncate text-xs text-black/55">{catalog.tenant.tagline}</p>
              ) : null}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setCartOpen((value) => !value)}
            className="relative rounded-full px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:opacity-90"
            style={{ backgroundColor: accent }}
          >
            Carrinho · {money(subtotal, currency)}
            {itemCount > 0 ? (
              <span className="absolute -right-2 -top-2 grid h-6 min-w-6 place-items-center rounded-full bg-[#28251f] px-1 text-xs text-white">
                {itemCount}
              </span>
            ) : null}
          </button>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 pb-6 pt-10 sm:px-6 sm:pt-14">
        <div className="max-w-3xl">
          <span
            className="inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.16em]"
            style={{ backgroundColor: accentSoft, color: accent }}
          >
            Peça direto
          </span>
          <h1 className="mt-4 text-4xl font-bold leading-[1.05] sm:text-5xl">
            {catalog.tenant.headline ?? "Seu pedido, do seu jeito."}
          </h1>
          {catalog.tenant.description ? (
            <p className="mt-4 max-w-2xl text-base leading-7 text-black/60 sm:text-lg">
              {catalog.tenant.description}
            </p>
          ) : null}
        </div>

        <div className="mt-8 flex gap-2 overflow-x-auto pb-2">
          <button
            type="button"
            onClick={() => setActiveCategory("all")}
            className="shrink-0 rounded-full border px-4 py-2 text-sm font-bold transition"
            style={
              activeCategory === "all"
                ? { backgroundColor: accent, borderColor: accent, color: "white" }
                : { borderColor: "rgba(0,0,0,.12)", backgroundColor: "white" }
            }
          >
            Todos
          </button>
          {catalog.categories.map((category) => (
            <button
              type="button"
              key={category.id}
              onClick={() => setActiveCategory(category.id)}
              className="shrink-0 rounded-full border px-4 py-2 text-sm font-bold transition"
              style={
                activeCategory === category.id
                  ? { backgroundColor: accent, borderColor: accent, color: "white" }
                  : { borderColor: "rgba(0,0,0,.12)", backgroundColor: "white" }
              }
            >
              {category.name}
            </button>
          ))}
        </div>
      </section>

      <div className="mx-auto grid max-w-6xl gap-8 px-4 pb-24 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section>
          <div className="grid gap-4 sm:grid-cols-2">
            {visibleProducts.map((product) => (
              <article
                key={product.id}
                className="group flex min-h-52 flex-col rounded-3xl border border-black/5 bg-white p-5 shadow-[0_8px_30px_rgba(40,37,31,0.04)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_38px_rgba(40,37,31,0.08)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div
                    className="grid h-14 w-14 place-items-center overflow-hidden rounded-2xl text-3xl"
                    style={{ backgroundColor: accentSoft }}
                  >
                    {product.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={product.image_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      product.emoji ?? "🍽️"
                    )}
                  </div>
                  <strong className="text-lg">{money(product.price_cents, currency)}</strong>
                </div>

                <div className="mt-5 flex-1">
                  <h2 className="text-lg font-bold">{product.name}</h2>
                  {product.description ? (
                    <p className="mt-1.5 text-sm leading-6 text-black/55">{product.description}</p>
                  ) : null}
                </div>

                <button
                  type="button"
                  onClick={() => addProduct(product)}
                  className="mt-5 w-full rounded-2xl py-3 text-sm font-bold text-white transition hover:opacity-90"
                  style={{ backgroundColor: accent }}
                >
                  Adicionar
                </button>
              </article>
            ))}
          </div>
        </section>

        <aside
          className={`${cartOpen ? "block" : "hidden"} lg:block`}
          aria-label="Carrinho"
        >
          <div className="sticky top-5 rounded-3xl border border-black/5 bg-white p-5 shadow-[0_12px_40px_rgba(40,37,31,0.07)]">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">Seu pedido</p>
                <h2 className="mt-1 text-xl font-bold">
                  {itemCount > 0 ? `${itemCount} ${itemCount === 1 ? "item" : "itens"}` : "Carrinho vazio"}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="rounded-full border border-black/10 px-3 py-1.5 text-xs font-bold lg:hidden"
              >
                Fechar
              </button>
            </div>

            {cart.length === 0 && !success ? (
              <div className="mt-6 rounded-2xl bg-[#faf8f4] p-5 text-center">
                <div className="text-3xl">🛒</div>
                <p className="mt-2 text-sm text-black/55">
                  Adicione um produto para começar o pedido.
                </p>
              </div>
            ) : null}

            {cart.length > 0 ? (
              <>
                <div className="mt-5 space-y-3">
                  {cart.map((line) => (
                    <div key={line.key} className="rounded-2xl border border-black/7 p-3">
                      <div className="flex items-start gap-3">
                        <div
                          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-xl"
                          style={{ backgroundColor: accentSoft }}
                        >
                          {line.product.emoji ?? "🍽️"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold leading-5">{line.product.name}</p>
                          <p className="mt-0.5 text-xs text-black/50">
                            {money(line.product.price_cents, currency)}
                          </p>
                          {line.recommendationRuleId ? (
                            <span
                              className="mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold"
                              style={{ backgroundColor: accentSoft, color: accent }}
                            >
                              sugestão aceita
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2 rounded-full bg-[#faf8f4] p-1">
                          <button
                            type="button"
                            onClick={() => changeQuantity(line.key, -1)}
                            className="grid h-7 w-7 place-items-center rounded-full bg-white text-sm font-bold shadow-sm"
                            aria-label={`Diminuir ${line.product.name}`}
                          >
                            −
                          </button>
                          <span className="min-w-5 text-center text-xs font-bold">{line.quantity}</span>
                          <button
                            type="button"
                            onClick={() => changeQuantity(line.key, 1)}
                            className="grid h-7 w-7 place-items-center rounded-full bg-white text-sm font-bold shadow-sm"
                            aria-label={`Aumentar ${line.product.name}`}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {goalThreshold ? (
                  <div className="mt-5 rounded-2xl p-4" style={{ backgroundColor: accentSoft }}>
                    <div className="flex items-center justify-between gap-3 text-xs font-bold">
                      <span style={{ color: accent }}>
                        {goalRemaining > 0
                          ? `Faltam ${money(goalRemaining, currency)}`
                          : "Meta alcançada ✓"}
                      </span>
                      <span className="text-black/45">{Math.round(goalProgress)}%</span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/70">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${goalProgress}%`, backgroundColor: accent }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-black/55">
                      {goalRemaining > 0
                        ? "Complete a meta do carrinho e aumente o benefício do pedido."
                        : "Seu carrinho já atingiu a meta configurada."}
                    </p>
                  </div>
                ) : null}

                {suggestions.length > 0 ? (
                  <div className="mt-5">
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">
                      Combina com seu pedido
                    </p>
                    <div className="mt-2 space-y-2">
                      {suggestions.map(({ rule, product }) => (
                        <div
                          key={rule.id}
                          className="flex items-center gap-3 rounded-2xl border border-black/7 p-3"
                        >
                          <div
                            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-xl"
                            style={{ backgroundColor: accentSoft }}
                          >
                            {product.emoji ?? "✨"}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-bold">{product.name}</p>
                            <p className="text-xs text-black/50">{money(product.price_cents, currency)}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => addProduct(product, rule.id)}
                            className="rounded-full px-3 py-2 text-xs font-bold text-white"
                            style={{ backgroundColor: accent }}
                          >
                            + Adicionar
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="mt-5 flex items-center justify-between border-t border-black/8 pt-4">
                  <span className="text-sm text-black/55">Subtotal</span>
                  <strong className="text-xl">{money(subtotal, currency)}</strong>
                </div>

                <form className="mt-5 space-y-3" onSubmit={submitOrder}>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-black/55">Nome</span>
                      <input
                        value={customerName}
                        onChange={(event) => setCustomerName(event.target.value)}
                        required
                        maxLength={160}
                        placeholder="Seu nome"
                        className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm outline-none transition focus:border-black/30"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-black/55">WhatsApp</span>
                      <input
                        value={phone}
                        onChange={(event) => setPhone(event.target.value)}
                        required
                        minLength={8}
                        maxLength={30}
                        inputMode="tel"
                        placeholder="(12) 99999-9999"
                        className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm outline-none transition focus:border-black/30"
                      />
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    {(["retirada", "entrega"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setFulfillment(option)}
                        className="rounded-2xl border px-3 py-3 text-xs font-bold capitalize"
                        style={
                          fulfillment === option
                            ? { borderColor: accent, backgroundColor: accentSoft, color: accent }
                            : { borderColor: "rgba(0,0,0,.10)" }
                        }
                      >
                        {option}
                      </button>
                    ))}
                  </div>

                  {fulfillment === "entrega" ? (
                    <label className="block">
                      <span className="mb-1 block text-xs font-bold text-black/55">
                        Endereço / referência
                      </span>
                      <textarea
                        value={addressNotes}
                        onChange={(event) => setAddressNotes(event.target.value)}
                        maxLength={500}
                        required
                        rows={3}
                        placeholder="Rua, número, bairro e complemento"
                        className="w-full resize-none rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm outline-none transition focus:border-black/30"
                      />
                    </label>
                  ) : null}

                  <label className="block">
                    <span className="mb-1 block text-xs font-bold text-black/55">Pagamento</span>
                    <select
                      value={paymentMethod}
                      onChange={(event) =>
                        setPaymentMethod(event.target.value as "pix" | "cartao" | "dinheiro")
                      }
                      className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-sm outline-none"
                    >
                      <option value="pix">PIX</option>
                      <option value="cartao">Cartão</option>
                      <option value="dinheiro">Dinheiro</option>
                    </select>
                  </label>

                  <label className="flex items-start gap-2 rounded-2xl bg-[#faf8f4] p-3">
                    <input
                      type="checkbox"
                      checked={marketingConsent}
                      onChange={(event) => setMarketingConsent(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-xs leading-5 text-black/55">
                      Aceito receber novidades e ofertas desta loja pelo WhatsApp.
                    </span>
                  </label>

                  {checkoutError ? (
                    <div className="rounded-2xl bg-red-50 p-3 text-xs font-bold text-red-700">
                      {checkoutError}
                    </div>
                  ) : null}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full rounded-2xl py-3.5 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-60"
                    style={{ backgroundColor: accent }}
                  >
                    {submitting ? "Criando pedido..." : `Finalizar · ${money(subtotal, currency)}`}
                  </button>
                </form>
              </>
            ) : null}

            {success ? (
              <div className="mt-5 rounded-2xl bg-emerald-50 p-5">
                <div className="text-2xl">✅</div>
                <h3 className="mt-2 font-bold text-emerald-900">Pedido recebido!</h3>
                <p className="mt-1 text-sm text-emerald-800">
                  Total: {money(success.total_cents, success.currency)}
                </p>
                <p className="mt-2 break-all text-[11px] text-emerald-800/70">
                  Pedido {success.order_id}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSuccess(null);
                    setCustomerName("");
                    setPhone("");
                    setAddressNotes("");
                    setMarketingConsent(false);
                  }}
                  className="mt-4 rounded-full bg-emerald-900 px-4 py-2 text-xs font-bold text-white"
                >
                  Fazer outro pedido
                </button>
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      {itemCount > 0 && !cartOpen ? (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-black/10 bg-white p-3 shadow-[0_-10px_30px_rgba(0,0,0,.08)] lg:hidden">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="mx-auto flex w-full max-w-md items-center justify-between rounded-2xl px-5 py-4 text-sm font-bold text-white"
            style={{ backgroundColor: accent }}
          >
            <span>Ver carrinho · {itemCount} {itemCount === 1 ? "item" : "itens"}</span>
            <span>{money(subtotal, currency)}</span>
          </button>
        </div>
      ) : null}
    </main>
  );
}

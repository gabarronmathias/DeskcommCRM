"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type FoodStatus =
  | "new"
  | "accepted"
  | "preparing"
  | "ready"
  | "out_for_delivery"
  | "completed"
  | "cancelled";

type OrderItem = {
  id: string;
  product_id: string | null;
  product_name_snapshot: string;
  unit_price_cents: number;
  quantity: number;
  line_total_cents: number;
  selected_modifiers: Array<{
    id?: string;
    name?: string;
    group_name?: string;
    price_delta_cents?: number;
  }>;
  added_via_recommendation: boolean;
  recommendation_rule_id: string | null;
};

type Contact = {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
};

type Order = {
  id: string;
  external_id: string;
  status: string;
  food_status: FoodStatus | null;
  food_status_updated_at: string | null;
  total_cents: number;
  currency: string;
  payment_method: string | null;
  payload: {
    fulfillment?: "entrega" | "retirada";
    address_notes?: string;
  };
  ordered_at: string;
  contact_id: string | null;
  contacts: Contact | null;
  food_order_items: OrderItem[];
};

type Column = {
  key: string;
  title: string;
  statuses: FoodStatus[];
};

const COLUMNS: Column[] = [
  {
    key: "new",
    title: "Novos",
    statuses: ["new", "accepted"],
  },
  {
    key: "preparing",
    title: "Em preparo",
    statuses: ["preparing"],
  },
  {
    key: "ready",
    title: "Prontos / Entrega",
    statuses: ["ready", "out_for_delivery"],
  },
  {
    key: "completed",
    title: "Finalizados",
    statuses: ["completed", "cancelled"],
  },
];

function money(cents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function time(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusLabel(status: FoodStatus) {
  const labels: Record<FoodStatus, string> = {
    new: "Novo",
    accepted: "Aceito",
    preparing: "Em preparo",
    ready: "Pronto",
    out_for_delivery: "Saiu para entrega",
    completed: "Concluído",
    cancelled: "Cancelado",
  };

  return labels[status];
}

function nextAction(order: Order): {
  label: string;
  status: FoodStatus;
} | null {
  const status = order.food_status ?? "new";
  const fulfillment = order.payload?.fulfillment ?? "retirada";

  if (status === "new") {
    return { label: "Aceitar pedido", status: "accepted" };
  }

  if (status === "accepted") {
    return { label: "Iniciar preparo", status: "preparing" };
  }

  if (status === "preparing") {
    return { label: "Marcar como pronto", status: "ready" };
  }

  if (status === "ready") {
    if (fulfillment === "entrega") {
      return {
        label: "Saiu para entrega",
        status: "out_for_delivery",
      };
    }

    return {
      label: "Concluir retirada",
      status: "completed",
    };
  }

  if (status === "out_for_delivery") {
    return {
      label: "Concluir pedido",
      status: "completed",
    };
  }

  return null;
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const knownNewOrders = useRef<Set<string>>(new Set());
  const firstLoad = useRef(true);

  const loadOrders = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/orders?limit=150", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("Não foi possível carregar os pedidos.");
      }

      const body = await response.json();
      const nextOrders: Order[] = body.data ?? [];

      const currentNewIds = new Set(
        nextOrders
          .filter((order) => (order.food_status ?? "new") === "new")
          .map((order) => order.id),
      );

      if (!firstLoad.current) {
        const hasNewOrder = [...currentNewIds].some(
          (id) => !knownNewOrders.current.has(id),
        );

        if (hasNewOrder && typeof window !== "undefined") {
          document.title = "🔔 Novo pedido | Deskcomm";

          setTimeout(() => {
            document.title = "Pedidos | Deskcomm";
          }, 10000);
        }
      }

      knownNewOrders.current = currentNewIds;
      firstLoad.current = false;

      setOrders(nextOrders);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Erro ao carregar pedidos.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOrders();

    const interval = window.setInterval(() => {
      void loadOrders();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [loadOrders]);

  async function moveOrder(
    order: Order,
    status: FoodStatus,
  ) {
    setUpdatingId(order.id);

    try {
      const response = await fetch(
        `/api/v1/orders/${order.id}/status`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status }),
        },
      );

      const body = await response.json();

      if (!response.ok) {
        throw new Error(
          body?.error?.message ??
            "Não foi possível atualizar o pedido.",
        );
      }

      await loadOrders();
    } catch (err) {
      window.alert(
        err instanceof Error
          ? err.message
          : "Erro ao atualizar pedido.",
      );
    } finally {
      setUpdatingId(null);
    }
  }

  const ordersByColumn = useMemo(() => {
    return COLUMNS.map((column) => ({
      ...column,
      orders: orders.filter((order) =>
        column.statuses.includes(order.food_status ?? "new"),
      ),
    }));
  }, [orders]);

  const newCount = orders.filter(
    (order) => (order.food_status ?? "new") === "new",
  ).length;

  const preparingCount = orders.filter((order) =>
    ["accepted", "preparing"].includes(
      order.food_status ?? "new",
    ),
  ).length;

  const readyCount = orders.filter((order) =>
    ["ready", "out_for_delivery"].includes(
      order.food_status ?? "new",
    ),
  ).length;

  const todayRevenue = orders
    .filter((order) => {
      const ordered = new Date(order.ordered_at);
      const today = new Date();

      return (
        ordered.getDate() === today.getDate() &&
        ordered.getMonth() === today.getMonth() &&
        ordered.getFullYear() === today.getFullYear() &&
        order.food_status !== "cancelled"
      );
    })
    .reduce((sum, order) => sum + order.total_cents, 0);

  if (loading) {
    return (
      <div className="p-6">
        <div className="rounded-xl border bg-card p-8 text-sm text-muted-foreground">
          Carregando central de pedidos...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              Pedidos
            </h1>

            {newCount > 0 ? (
              <span className="rounded-full bg-red-500 px-2.5 py-1 text-xs font-semibold text-white">
                {newCount} novo{newCount > 1 ? "s" : ""}
              </span>
            ) : null}
          </div>

          <p className="mt-1 text-sm text-muted-foreground">
            Central operacional do restaurante em tempo real.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadOrders()}
          className="rounded-lg border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Atualizar agora
        </button>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Novos
          </div>
          <div className="mt-2 text-3xl font-semibold">
            {newCount}
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Em produção
          </div>
          <div className="mt-2 text-3xl font-semibold">
            {preparingCount}
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Prontos / entrega
          </div>
          <div className="mt-2 text-3xl font-semibold">
            {readyCount}
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Faturamento hoje
          </div>
          <div className="mt-2 text-3xl font-semibold">
            {money(todayRevenue)}
          </div>
        </div>
      </section>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <section className="grid min-w-[1000px] grid-cols-4 gap-4 overflow-x-auto pb-4">
        {ordersByColumn.map((column) => (
          <div
            key={column.key}
            className="min-h-[520px] rounded-2xl border bg-muted/30 p-3"
          >
            <div className="mb-3 flex items-center justify-between px-1">
              <h2 className="font-semibold">
                {column.title}
              </h2>

              <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {column.orders.length}
              </span>
            </div>

            <div className="space-y-3">
              {column.orders.length === 0 ? (
                <div className="rounded-xl border border-dashed bg-background/50 p-6 text-center text-sm text-muted-foreground">
                  Nenhum pedido aqui.
                </div>
              ) : (
                column.orders.map((order) => {
                  const status = order.food_status ?? "new";
                  const action = nextAction(order);
                  const customer =
                    order.contacts?.display_name ||
                    order.contacts?.name ||
                    order.contacts?.phone_number ||
                    "Cliente";

                  const fulfillment =
                    order.payload?.fulfillment ?? "retirada";

                  return (
                    <article
                      key={order.id}
                      className={
                        status === "new"
                          ? "rounded-xl border-2 border-red-400 bg-card p-4 shadow-sm"
                          : "rounded-xl border bg-card p-4 shadow-sm"
                      }
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            {time(order.ordered_at)}
                          </div>

                          <div className="mt-1 font-semibold">
                            {customer}
                          </div>
                        </div>

                        <span className="rounded-full bg-muted px-2 py-1 text-[11px] font-semibold">
                          {statusLabel(status)}
                        </span>
                      </div>

                      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="rounded-md border px-2 py-1">
                          {fulfillment === "entrega"
                            ? "Entrega"
                            : "Retirada"}
                        </span>

                        {order.payment_method ? (
                          <span className="rounded-md border px-2 py-1 capitalize">
                            {order.payment_method}
                          </span>
                        ) : null}
                      </div>

                      <div className="my-4 border-t" />

                      <div className="space-y-3">
                        {order.food_order_items.map((item) => (
                          <div
                            key={item.id}
                            className="flex items-start justify-between gap-3 text-sm"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="font-medium">
                                {item.quantity}x{" "}
                                {item.product_name_snapshot}
                              </div>

                              {item.added_via_recommendation ? (
                                <span className="mt-1 inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                                  + Ticket médio
                                </span>
                              ) : null}

                              {Array.isArray(
                                item.selected_modifiers,
                              ) &&
                              item.selected_modifiers.length > 0 ? (
                                <div className="mt-1 text-xs text-muted-foreground">
                                  {item.selected_modifiers
                                    .map(
                                      (modifier) =>
                                        modifier.name,
                                    )
                                    .filter(Boolean)
                                    .join(", ")}
                                </div>
                              ) : null}
                            </div>

                            <div className="whitespace-nowrap text-sm font-medium">
                              {money(item.line_total_cents)}
                            </div>
                          </div>
                        ))}
                      </div>

                      {order.payload?.address_notes ? (
                        <>
                          <div className="my-4 border-t" />

                          <div className="text-xs">
                            <div className="font-semibold">
                              Entrega / observações
                            </div>
                            <div className="mt-1 text-muted-foreground">
                              {order.payload.address_notes}
                            </div>
                          </div>
                        </>
                      ) : null}

                      <div className="my-4 border-t" />

                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">
                          Total
                        </span>

                        <span className="text-lg font-semibold">
                          {money(order.total_cents)}
                        </span>
                      </div>

                      {action ? (
                        <button
                          type="button"
                          disabled={updatingId === order.id}
                          onClick={() =>
                            void moveOrder(
                              order,
                              action.status,
                            )
                          }
                          className="mt-4 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {updatingId === order.id
                            ? "Atualizando..."
                            : action.label}
                        </button>
                      ) : null}

                      {!["completed", "cancelled"].includes(
                        status,
                      ) ? (
                        <button
                          type="button"
                          disabled={updatingId === order.id}
                          onClick={() => {
                            if (
                              window.confirm(
                                "Cancelar este pedido?",
                              )
                            ) {
                              void moveOrder(
                                order,
                                "cancelled",
                              );
                            }
                          }}
                          className="mt-2 w-full rounded-lg px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          Cancelar pedido
                        </button>
                      ) : null}
                    </article>
                  );
                })
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

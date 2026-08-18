"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface DeliveryReport {
  period: { from: string; to: string };
  sarah: { contacts_served: number; messages_sent: number };
  delivery: { orders_count: number; gross_revenue_cents: number; average_ticket_cents: number };
  upsell: {
    offers: number;
    orders_with_upsell: number;
    items_sold: number;
    revenue_cents: number;
  };
  campaigns: { sent: number; contacts: number; orders: number; revenue_cents: number };
  recoveries: { sent: number; contacts: number; orders: number; revenue_cents: number };
  sarah_influenced_revenue_cents: number;
}

function todayWindow() {
  const to = new Date();
  const from = new Date(to);
  from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function useDeliveryReport() {
  const window = todayWindow();
  const qs = new URLSearchParams(window).toString();

  return useQuery({
    queryKey: ["metrics", "delivery", window.from.slice(0, 10)],
    queryFn: async () =>
      apiClient.get<{ data: DeliveryReport }>(`/api/v1/metrics/delivery?${qs}`),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

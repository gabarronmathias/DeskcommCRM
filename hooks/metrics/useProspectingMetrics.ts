"use client";

import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

export interface ProspectingMetrics {
  leads_captured_today: number;
  leads_new: number;
  prospecting_messages_sent: number;
  opening_messages_sent: number;
  replies_received: number;
  response_rate: number;
  qualified_leads: number;
  meetings_scheduled: number;
  followups_sent: number;
  followups_active: number;
  opt_outs: number;
  send_failures: number;
  since: string;
  to: string;
}

export function useProspectingMetrics() {
  return useQuery({
    queryKey: ["metrics", "prospecting", "today"],
    queryFn: async () => apiClient.get<{ data: ProspectingMetrics }>("/api/v1/prospecting/metrics"),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

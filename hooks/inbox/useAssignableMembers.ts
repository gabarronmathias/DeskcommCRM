"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { tenantScopedQueryKey } from "@/lib/query/tenant-scope";

export interface AssignableMember {
  user_id: string;
  role: string;
  full_name: string | null;
}

/** G3-01: destinos válidos de transferência (membros ativos agent+ da org). */
export function useAssignableMembers(enabled: boolean) {
  const organizationId = useActiveOrg()?.orgId ?? null;
  return useQuery({
    queryKey: tenantScopedQueryKey(["team", "assignable"] as const, organizationId),
    queryFn: async () => apiClient.get<{ data: AssignableMember[] }>("/api/v1/team/assignable"),
    enabled: enabled && !!organizationId,
    staleTime: 60_000,
    select: (res) => res.data,
  });
}

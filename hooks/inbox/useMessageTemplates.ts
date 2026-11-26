"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { tenantScopedQueryKey } from "@/lib/query/tenant-scope";

export interface MessageTemplate {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  owner_user_id: string | null;
}

/** Onda 5: templates de script (pessoais + compartilhados) para o slash-menu do composer. */
export function useMessageTemplates() {
  const organizationId = useActiveOrg()?.orgId ?? null;
  return useQuery({
    queryKey: tenantScopedQueryKey(["message-templates"] as const, organizationId),
    queryFn: async () => apiClient.get<{ data: MessageTemplate[] }>("/api/v1/message-templates"),
    enabled: !!organizationId,
    staleTime: 60_000,
    select: (res) => res.data,
  });
}

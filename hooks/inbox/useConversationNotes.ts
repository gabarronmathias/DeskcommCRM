"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Note } from "@/lib/types/messaging";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { tenantScopedQueryKey } from "@/lib/query/tenant-scope";

/** Onda 5.2: notas internas da conversa (poucas por conversa — query simples, sem paginação). */
export function useConversationNotes(conversationId: string | null) {
  const qc = useQueryClient();
  const organizationId = useActiveOrg()?.orgId ?? null;
  const queryKey = tenantScopedQueryKey(["notes", conversationId] as const, organizationId);

  const query = useQuery({
    queryKey,
    enabled: !!conversationId && !!organizationId,
    queryFn: async () => {
      try {
        return await apiClient.get<{ data: Note[] }>(
          `/api/v1/conversations/${conversationId}/notes`,
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    select: (res) => res.data,
  });

  const onChange = useCallback(() => {
    if (conversationId) qc.invalidateQueries({ queryKey: ["notes", conversationId] });
  }, [qc, conversationId]);

  useRealtimeChannel({
    name:
      conversationId && organizationId
        ? `conversation-notes-${organizationId}-${conversationId}`
        : "conversation-notes-disabled",
    postgresChanges:
      conversationId && organizationId
        ? {
            event: "*",
            schema: "public",
            table: "conversation_notes",
            filter: `organization_id=eq.${organizationId}`,
          }
        : undefined,
    onChange,
    enabled: !!conversationId && !!organizationId,
  });

  return query.data ?? [];
}

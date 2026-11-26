"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { TimelineItemView } from "@/lib/types/contacts";
import { tenantScopedQueryKey } from "@/lib/query/tenant-scope";

interface TimelineResponse {
  data: TimelineItemView[];
  meta?: { cursor?: string; has_more?: boolean };
}

export function useTimeline(
  contactId: string,
  types: string[] | undefined,
  organizationId: string | null,
) {
  return useInfiniteQuery({
    queryKey: tenantScopedQueryKey(["timeline", contactId, types ?? null] as const, organizationId),
    enabled: !!contactId && !!organizationId,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (pageParam) qs.set("cursor", pageParam);
      qs.set("limit", "30");
      if (types && types.length > 0) {
        for (const t of types) qs.append("type", t);
      }
      try {
        return await apiClient.get<TimelineResponse>(
          `/api/v1/contacts/${contactId}/timeline?${qs.toString()}`,
        );
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (lastPage) => (lastPage.meta?.has_more ? lastPage.meta.cursor : undefined),
  });
}

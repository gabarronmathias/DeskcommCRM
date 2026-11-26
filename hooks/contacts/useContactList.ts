"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Contact } from "@/lib/types/contacts";
import { tenantScopedQueryKey } from "@/lib/query/tenant-scope";

interface ListResponse {
  data: Contact[];
  meta?: { cursor?: string; has_more?: boolean };
}

export interface ContactListFilters {
  search?: string;
  tag?: string;
  source?: string;
}

export function useContactList(filters: ContactListFilters, organizationId: string | null) {
  return useInfiniteQuery({
    queryKey: tenantScopedQueryKey(["contacts", filters] as const, organizationId),
    enabled: !!organizationId,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (filters.search) qs.set("search", filters.search);
      if (filters.tag) qs.set("tag", filters.tag);
      if (filters.source) qs.set("source", filters.source);
      if (pageParam) qs.set("cursor", pageParam);
      qs.set("limit", "50");
      try {
        return await apiClient.get<ListResponse>(`/api/v1/contacts?${qs.toString()}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (lastPage) => (lastPage.meta?.has_more ? lastPage.meta.cursor : undefined),
  });
}

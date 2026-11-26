"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Contact } from "@/lib/types/contacts";
import { tenantScopedQueryKey } from "@/lib/query/tenant-scope";

interface ContactResponse {
  data: Contact;
  meta?: { cpf_available?: boolean };
}

export function useContact(id: string, organizationId: string | null) {
  return useQuery({
    queryKey: tenantScopedQueryKey(["contact", id] as const, organizationId),
    enabled: !!id && !!organizationId,
    queryFn: async () => {
      try {
        return await apiClient.get<ContactResponse>(`/api/v1/contacts/${id}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}

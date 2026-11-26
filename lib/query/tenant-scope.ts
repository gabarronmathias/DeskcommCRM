/** Acrescenta o tenant às chaves do React Query sem quebrar invalidações por prefixo. */
export function tenantScopedQueryKey<const T extends readonly unknown[]>(
  key: T,
  organizationId: string | null | undefined,
): [...T, string | null] {
  return [...key, organizationId ?? null];
}

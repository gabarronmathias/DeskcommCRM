import type { ImpersonatePayload } from "./cookie";

export const READ_ONLY_PREVIEW_MODE = "read_only_preview" as const;
export const IMPERSONATE_END_PATH = "/api/v1/admin/impersonate/end";

export function isAdminPreviewForTenant(input: {
  isPlatformAdmin: boolean;
  authUserId: string;
  activeOrgId: string | null;
  onboardedAt: string | null | undefined;
  payload: ImpersonatePayload | undefined;
}): boolean {
  const { isPlatformAdmin, authUserId, activeOrgId, onboardedAt, payload } = input;
  return Boolean(
    isPlatformAdmin &&
      !onboardedAt &&
      payload?.mode === READ_ONLY_PREVIEW_MODE &&
      payload.platformAdminId === authUserId &&
      payload.tenantId === activeOrgId,
  );
}

/**
 * Impersonation preview is read-only at the request boundary, including server
 * actions. Only the explicit end-impersonation endpoint may mutate state.
 */
export function shouldBlockReadOnlyPreviewMutation(input: {
  method: string;
  pathname: string;
  mode: ImpersonatePayload["mode"] | undefined;
}): boolean {
  if (input.mode !== READ_ONLY_PREVIEW_MODE) return false;
  if (input.pathname === IMPERSONATE_END_PATH) return false;
  return !["GET", "HEAD", "OPTIONS"].includes(input.method.toUpperCase());
}

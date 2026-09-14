/**
 * POST /api/v1/admin/impersonate/end (S-11.07)
 *
 * Terminates the active platform-admin impersonation session by deleting the
 * `gm-crm-impersonate` cookie. Audits the end event with the tenant id
 * derived from the cookie (best-effort; cookie is verified before audit).
 *
 * Idempotent: if no cookie present, still returns 200 with `ended: false`.
 */
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  IMPERSONATE_COOKIE_NAME,
  verifyImpersonateCookie,
} from "@/lib/impersonate/cookie";

export async function POST() {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const cookieStore = await cookies();
  const raw = cookieStore.get(IMPERSONATE_COOKIE_NAME)?.value ?? null;

  // Always clear, even if invalid — defence-in-depth against stale cookies.
  cookieStore.delete(IMPERSONATE_COOKIE_NAME);

  if (!raw) {
    return ok({ ended: false, tenant_id: null }, { requestId });
  }

  const result = verifyImpersonateCookie(raw);
  const tenantId = result.valid && result.payload ? result.payload.tenantId : null;

  void audit({
    action: "platform_admin.impersonate_ended",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: tenantId,
    resourceType: "organization",
    resourceId: tenantId,
    requestId,
    metadata: {
      tenant_id: tenantId,
      platform_admin_id: adminCtx.user.id,
      cookie_valid: result.valid,
      reason: result.reason ?? null,
    },
  });

  return ok({ ended: true, tenant_id: tenantId }, { requestId });
}

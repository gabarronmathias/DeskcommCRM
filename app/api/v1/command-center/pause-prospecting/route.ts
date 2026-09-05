import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runControl } from "../_control";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const user = await loadAuthUser();
  if (!user) return fail("unauthorized", "sessao ausente ou invalida", 401, { requestId });
  const org = await resolveActiveOrg(user);
  if (!org) return fail("no_org", "organizacao ativa nao resolvida", 400, { requestId });
  const body = await req.json().catch(() => ({}));
  return runControl({
    db: createAdminClient(),
    organizationId: org.orgId,
    requestId,
    action: "pause-prospecting",
    userId: user.id,
    body,
  });
}

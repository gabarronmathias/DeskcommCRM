/** Reenvia a mesma mensagem queued, sem criar duplicata. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { retryQueuedTextMessage } from "@/lib/messaging/retry-queued";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;

  const { id } = await context.params;
  const result = await retryQueuedTextMessage(await createClient(), {
    organizationId: authz.org.orgId,
    messageId: id,
    source: "operator",
  });
  if (result.outcome === "sent") return ok(result, { requestId });
  const status = result.outcome === "not_found" ? 404 : 409;
  return fail("message_not_sendable", "A mensagem ainda não pode ser enviada.", status, {
    details: { reason: result.reason },
    requestId,
  });
}

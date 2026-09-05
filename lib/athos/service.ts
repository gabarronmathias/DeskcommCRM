import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type AthosEvent,
  extractBearerToken,
  hashBearerToken,
} from "./contract";

export interface AthosConnection {
  id: string;
  environment: "sandbox";
  store_ref: string;
  menu_url: string;
  bearer_hash: string;
  scopes: string[];
  active: boolean;
  bearer_expires_at: string;
  revoked_at: string | null;
}

export type AthosAuthResult =
  | { ok: true; connection: AthosConnection; bearerToken: string }
  | { ok: false; status: 401 | 403; code: string; message: string };

export async function authenticateAthosPartner(
  authorizationHeader: string | null,
  requiredScope: "athos:launch:read" | "athos:events:write",
): Promise<AthosAuthResult> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    return { ok: false, status: 401, code: "unauthenticated", message: "invalid_bearer" };
  }

  const bearerHash = hashBearerToken(token);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("athos_sandbox_connections")
    .select(
      "id, environment, store_ref, menu_url, bearer_hash, scopes, active, bearer_expires_at, revoked_at",
    )
    .eq("bearer_hash", bearerHash)
    .eq("environment", "sandbox")
    .eq("active", true)
    .is("revoked_at", null)
    .gt("bearer_expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) {
    logger.error("[athos.sandbox.auth] connection lookup failed", { errorCode: error.code });
    return { ok: false, status: 401, code: "unauthenticated", message: "invalid_bearer" };
  }
  if (!data) {
    return { ok: false, status: 401, code: "unauthenticated", message: "invalid_bearer" };
  }

  const connection = data as AthosConnection;
  if (!connection.scopes.includes(requiredScope)) {
    return { ok: false, status: 403, code: "forbidden", message: "scope_missing" };
  }

  return { ok: true, connection, bearerToken: token };
}

async function validateAthosCorrelation(connection: AthosConnection, event: AthosEvent): Promise<void> {
  const launchId = event.correlation?.launch_id;
  if (!launchId) return;

  const admin = createAdminClient();
  const { data: launch, error } = await admin
    .from("athos_sandbox_launches")
    .select("crm_contact_id, store_ref")
    .eq("launch_id", launchId)
    .eq("connection_id", connection.id)
    .eq("store_ref", connection.store_ref)
    .maybeSingle();

  // launch expiry protects context retrieval only. Events may legitimately
  // arrive later as an order moves through preparing/delivery/completed.
  if (error || !launch) throw new Error("athos_launch_not_found");

  const explicitContactId = event.correlation?.crm_contact_id ?? null;
  if (explicitContactId && explicitContactId !== launch.crm_contact_id) {
    throw new Error("athos_correlation_mismatch");
  }
}

export async function processAthosEvent(
  connection: AthosConnection,
  event: AthosEvent,
  receiptId: string,
): Promise<void> {
  const admin = createAdminClient();
  try {
    await validateAthosCorrelation(connection, event);

    const { data: orderId, error: applyError } = await admin.rpc("fn_apply_athos_sandbox_order_snapshot", {
      p_connection_id: connection.id,
      p_event: event,
    });
    if (applyError || !orderId) {
      throw new Error(`apply_sandbox_snapshot_failed:${applyError?.code ?? "no_order_id"}`);
    }

    await admin
      .from("athos_sandbox_events")
      .update({ status: "processed", processed_at: new Date().toISOString(), error_message: null })
      .eq("id", receiptId)
      .eq("connection_id", connection.id);

    logger.info("[athos.sandbox.events] processed", {
      connectionId: connection.id,
      eventId: event.event_id,
      eventType: event.event_type,
      orderId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "unknown_processing_error";
    await admin
      .from("athos_sandbox_events")
      .update({ status: "error", processed_at: new Date().toISOString(), error_message: message })
      .eq("id", receiptId)
      .eq("connection_id", connection.id);

    logger.error("[athos.sandbox.events] processing failed", {
      connectionId: connection.id,
      eventId: event.event_id,
      eventType: event.event_type,
      error: message,
    });
  }
}

export async function createAthosLaunch(input: {
  contactId: string;
  conversationId?: string | null;
  customerDisplayName?: string | null;
  customerPhone?: string | null;
  storeRef: string;
}): Promise<{ launchId: string; expiresAt: string; menuUrl: string }> {
  const admin = createAdminClient();
  const { data: connection, error: connectionError } = await admin
    .from("athos_sandbox_connections")
    .select("id, store_ref, menu_url")
    .eq("store_ref", input.storeRef)
    .eq("environment", "sandbox")
    .eq("active", true)
    .is("revoked_at", null)
    .gt("bearer_expires_at", new Date().toISOString())
    .maybeSingle();
  if (connectionError || !connection) throw new Error("athos_sandbox_connection_not_available");

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data: launch, error: launchError } = await admin
    .from("athos_sandbox_launches")
    .insert({
      connection_id: connection.id,
      store_ref: input.storeRef,
      crm_contact_id: input.contactId,
      crm_conversation_id: input.conversationId ?? null,
      customer_display_name: input.customerDisplayName ?? null,
      customer_phone: input.customerPhone ?? null,
      expires_at: expiresAt,
    })
    .select("launch_id")
    .single();
  if (launchError || !launch) throw new Error("athos_sandbox_launch_create_failed");

  const url = new URL(connection.menu_url as string);
  url.searchParams.set("launch_id", launch.launch_id as string);
  return { launchId: launch.launch_id as string, expiresAt, menuUrl: url.toString() };
}

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type AthosEvent,
  extractBearerToken,
  hashBearerToken,
} from "./contract";

export interface AthosConnection {
  id: string;
  organization_id: string;
  environment: "sandbox" | "production";
  store_ref: string;
  menu_url: string;
  bearer_hash: string;
  hmac_secret_encrypted: string;
  scopes: string[];
  active: boolean;
  bearer_expires_at: string;
  revoked_at: string | null;
}

export type AthosAuthResult =
  | { ok: true; connection: AthosConnection }
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
    .from("partner_athos_connections")
    .select(
      "id, organization_id, environment, store_ref, menu_url, bearer_hash, hmac_secret_encrypted, scopes, active, bearer_expires_at, revoked_at",
    )
    .eq("bearer_hash", bearerHash)
    .eq("active", true)
    .is("revoked_at", null)
    .gt("bearer_expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) {
    logger.error("[athos.auth] connection lookup failed", { errorCode: error.code });
    return { ok: false, status: 401, code: "unauthenticated", message: "invalid_bearer" };
  }
  if (!data) {
    return { ok: false, status: 401, code: "unauthenticated", message: "invalid_bearer" };
  }

  const connection = data as AthosConnection;
  if (!connection.scopes.includes(requiredScope)) {
    return { ok: false, status: 403, code: "forbidden", message: "scope_missing" };
  }

  return { ok: true, connection };
}

export async function decryptAthosHmacSecret(connection: AthosConnection): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_decrypt_oauth", {
    ciphertext: connection.hmac_secret_encrypted,
  });
  if (error || !data) {
    logger.error("[athos.crypto] HMAC secret decrypt failed", {
      organizationId: connection.organization_id,
      connectionId: connection.id,
      errorCode: error?.code,
    });
    return null;
  }
  return data as string;
}

export async function resolveAthosContactId(
  connection: AthosConnection,
  event: AthosEvent,
): Promise<string | null> {
  const admin = createAdminClient();
  let launchContactId: string | null = null;

  if (event.correlation?.launch_id) {
    const { data: launch } = await admin
      .from("partner_athos_launches")
      .select("contact_id")
      .eq("launch_id", event.correlation.launch_id)
      .eq("connection_id", connection.id)
      .eq("organization_id", connection.organization_id)
      .maybeSingle();
    launchContactId = (launch?.contact_id as string | undefined) ?? null;
  }

  const explicitContactId = event.correlation?.crm_contact_id ?? null;
  let validatedExplicitId: string | null = null;
  if (explicitContactId) {
    const { data: contact } = await admin
      .from("contacts")
      .select("id")
      .eq("id", explicitContactId)
      .eq("organization_id", connection.organization_id)
      .maybeSingle();
    validatedExplicitId = (contact?.id as string | undefined) ?? null;
  }

  if (launchContactId && validatedExplicitId && launchContactId !== validatedExplicitId) {
    throw new Error("athos_correlation_mismatch");
  }

  return launchContactId ?? validatedExplicitId;
}

export async function processAthosEvent(
  connection: AthosConnection,
  event: AthosEvent,
  receiptId: string,
): Promise<void> {
  const admin = createAdminClient();
  try {
    const contactId = await resolveAthosContactId(connection, event);
    const { data: orderId, error: applyError } = await admin.rpc("fn_apply_athos_order_snapshot", {
      p_organization_id: connection.organization_id,
      p_contact_id: contactId,
      p_event: event,
    });
    if (applyError || !orderId) {
      throw new Error(`apply_snapshot_failed:${applyError?.code ?? "no_order_id"}`);
    }

    await admin
      .from("partner_athos_events")
      .update({ status: "processed", processed_at: new Date().toISOString(), error_message: null })
      .eq("id", receiptId)
      .eq("organization_id", connection.organization_id);

    await admin
      .from("webhook_events_log")
      .update({ status: "processed", processed_at: new Date().toISOString(), error_message: null })
      .eq("provider", "athos")
      .eq("organization_id", connection.organization_id)
      .eq("external_id", event.event_id);

    const eventLogType = `athos.${event.event_type.replace(".", "_")}`;
    const { error: emitError } = await admin.rpc("emit_event", {
      p_event_type: eventLogType,
      p_entity_kind: "athos_order",
      p_entity_id: orderId,
      p_payload: event,
      p_metadata: {
        event_id: event.event_id,
        external_order_id: event.order.id,
        store_ref: event.store_ref,
      },
      p_organization_id: connection.organization_id,
    });
    if (emitError) {
      logger.warn("[athos.events] emit_event failed", {
        organizationId: connection.organization_id,
        eventId: event.event_id,
        errorCode: emitError.code,
      });
    }

    await audit({
      action: "athos.webhook_processed",
      organizationId: connection.organization_id,
      resourceType: "athos_order",
      resourceId: String(orderId),
      metadata: { event_id: event.event_id, event_type: event.event_type, store_ref: event.store_ref },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "unknown_processing_error";
    await admin
      .from("partner_athos_events")
      .update({ status: "error", processed_at: new Date().toISOString(), error_message: message })
      .eq("id", receiptId)
      .eq("organization_id", connection.organization_id);
    await admin
      .from("webhook_events_log")
      .update({ status: "error", processed_at: new Date().toISOString(), error_message: message })
      .eq("provider", "athos")
      .eq("organization_id", connection.organization_id)
      .eq("external_id", event.event_id);

    logger.error("[athos.events] processing failed", {
      organizationId: connection.organization_id,
      eventId: event.event_id,
      eventType: event.event_type,
      error: message,
    });
    await audit({
      action: "athos.webhook_processing_failed",
      organizationId: connection.organization_id,
      resourceType: "athos_webhook",
      resourceId: event.event_id,
      metadata: { event_type: event.event_type, error: message },
    });
  }
}

export async function createAthosLaunch(input: {
  organizationId: string;
  contactId: string;
  conversationId?: string | null;
  storeRef: string;
}): Promise<{ launchId: string; expiresAt: string; menuUrl: string }> {
  const admin = createAdminClient();
  const { data: connection, error: connectionError } = await admin
    .from("partner_athos_connections")
    .select("id, organization_id, store_ref, menu_url")
    .eq("organization_id", input.organizationId)
    .eq("store_ref", input.storeRef)
    .eq("active", true)
    .is("revoked_at", null)
    .gt("bearer_expires_at", new Date().toISOString())
    .maybeSingle();
  if (connectionError || !connection) throw new Error("athos_connection_not_available");

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data: launch, error: launchError } = await admin
    .from("partner_athos_launches")
    .insert({
      organization_id: input.organizationId,
      connection_id: connection.id,
      store_ref: input.storeRef,
      contact_id: input.contactId,
      conversation_id: input.conversationId ?? null,
      expires_at: expiresAt,
    })
    .select("launch_id")
    .single();
  if (launchError || !launch) throw new Error("athos_launch_create_failed");

  const url = new URL(connection.menu_url as string);
  url.searchParams.set("launch_id", launch.launch_id as string);
  return { launchId: launch.launch_id as string, expiresAt, menuUrl: url.toString() };
}

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const encoder = new TextEncoder();
const EVENT_TYPES = new Set([
  "order.created",
  "order.updated",
  "order.status_changed",
  "order.completed",
  "order.cancelled",
]);
const ORDER_STATUSES = new Set([
  "pending",
  "confirmed",
  "preparing",
  "ready",
  "out_for_delivery",
  "completed",
  "cancelled",
]);
const REPLAY_WINDOW_SECONDS = 300;
const RATE_LIMIT_PER_MINUTE = 120;

function headers(requestId: string): HeadersInit {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": requestId,
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "authorization, content-type, x-athos-timestamp, x-athos-signature",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function reply(requestId: string, status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: headers(requestId) });
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesFromHex(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return null;
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function verifyHmac(
  secret: string,
  message: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader || !/^v1=[0-9a-f]{64}$/i.test(signatureHeader)) return false;
  const signature = bytesFromHex(signatureHeader.slice(3));
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(message));
}

function extractBearer(value: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(value?.trim() ?? "");
  const token = match?.[1]?.trim() ?? "";
  return token.length >= 16 ? token : null;
}

type Connection = {
  id: string;
  store_ref: string;
  menu_url: string;
  scopes: string[];
};

async function authenticate(
  req: Request,
  scope: "athos:launch:read" | "athos:events:write",
): Promise<
  | { ok: true; connection: Connection; bearer: string }
  | { ok: false; status: number; message: string }
> {
  const bearer = extractBearer(req.headers.get("authorization"));
  if (!bearer) return { ok: false, status: 401, message: "invalid_bearer" };

  const bearerHash = await sha256Hex(bearer);
  const { data, error } = await supabase
    .from("athos_sandbox_connections")
    .select("id, store_ref, menu_url, scopes")
    .eq("bearer_hash", bearerHash)
    .eq("environment", "sandbox")
    .eq("active", true)
    .is("revoked_at", null)
    .gt("bearer_expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !data) return { ok: false, status: 401, message: "invalid_bearer" };
  const connection = data as Connection;
  if (!connection.scopes.includes(scope)) {
    return { ok: false, status: 403, message: "scope_missing" };
  }
  return { ok: true, connection, bearer };
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function finiteNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

function validateEvent(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid_event";
  const event = raw as Record<string, unknown>;
  if (typeof event.event_id !== "string" || event.event_id.length < 1 || event.event_id.length > 200) {
    return "invalid_event_id";
  }
  if (typeof event.event_type !== "string" || !EVENT_TYPES.has(event.event_type)) {
    return "invalid_event_type";
  }
  if (typeof event.occurred_at !== "string" || !Number.isFinite(Date.parse(event.occurred_at))) {
    return "invalid_occurred_at";
  }
  if (typeof event.store_ref !== "string" || event.store_ref.length < 1 || event.store_ref.length > 160) {
    return "invalid_store_ref";
  }

  if (event.correlation !== undefined) {
    if (!event.correlation || typeof event.correlation !== "object" || Array.isArray(event.correlation)) {
      return "invalid_correlation";
    }
    const corr = event.correlation as Record<string, unknown>;
    if (corr.launch_id !== undefined && !isUuid(corr.launch_id)) return "invalid_launch_id";
    if (corr.crm_contact_id !== undefined && !isUuid(corr.crm_contact_id)) {
      return "invalid_crm_contact_id";
    }
    if (corr.crm_conversation_id !== undefined && !isUuid(corr.crm_conversation_id)) {
      return "invalid_crm_conversation_id";
    }
  }

  if (!event.order || typeof event.order !== "object" || Array.isArray(event.order)) {
    return "invalid_order";
  }
  const order = event.order as Record<string, unknown>;
  if (typeof order.id !== "string" || order.id.length < 1 || order.id.length > 200) {
    return "invalid_order_id";
  }
  if (typeof order.status !== "string" || !ORDER_STATUSES.has(order.status)) {
    return "invalid_order_status";
  }
  if (!finiteNonNegativeInteger(order.total_cents)) return "invalid_total_cents";
  if (typeof order.created_at !== "string" || !Number.isFinite(Date.parse(order.created_at))) {
    return "invalid_created_at";
  }
  if (
    order.updated_at !== undefined &&
    (typeof order.updated_at !== "string" || !Number.isFinite(Date.parse(order.updated_at)))
  ) {
    return "invalid_updated_at";
  }
  if (!Array.isArray(order.items) || order.items.length < 1 || order.items.length > 200) {
    return "invalid_items";
  }

  for (const itemRaw of order.items) {
    if (!itemRaw || typeof itemRaw !== "object" || Array.isArray(itemRaw)) return "invalid_item";
    const item = itemRaw as Record<string, unknown>;
    if (typeof item.product_id !== "string" || item.product_id.length < 1 || item.product_id.length > 200) {
      return "invalid_product_id";
    }
    if (typeof item.name !== "string" || item.name.length < 1 || item.name.length > 300) {
      return "invalid_product_name";
    }
    if (
      typeof item.quantity !== "number" ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 999
    ) {
      return "invalid_quantity";
    }
    if (!finiteNonNegativeInteger(item.unit_price_cents)) return "invalid_unit_price";
    if (!finiteNonNegativeInteger(item.line_total_cents)) return "invalid_line_total";
    if (item.modifiers !== undefined && !Array.isArray(item.modifiers)) return "invalid_modifiers";
  }
  return null;
}

async function handleGetLaunch(req: Request, requestId: string, launchId: string): Promise<Response> {
  if (!isUuid(launchId)) {
    return reply(requestId, 404, { error: { code: "not_found", message: "launch_not_found" } });
  }
  const auth = await authenticate(req, "athos:launch:read");
  if (!auth.ok) {
    return reply(requestId, auth.status, {
      error: { code: auth.status === 403 ? "forbidden" : "unauthenticated", message: auth.message },
    });
  }

  const { data: launch, error } = await supabase
    .from("athos_sandbox_launches")
    .select(
      "launch_id, store_ref, expires_at, crm_contact_id, crm_conversation_id, customer_display_name, customer_phone",
    )
    .eq("launch_id", launchId)
    .eq("connection_id", auth.connection.id)
    .eq("store_ref", auth.connection.store_ref)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !launch) {
    return reply(requestId, 404, { error: { code: "not_found", message: "launch_not_found" } });
  }
  return reply(requestId, 200, {
    data: {
      launch_id: launch.launch_id,
      store_ref: launch.store_ref,
      expires_at: launch.expires_at,
      correlation: {
        crm_contact_id: launch.crm_contact_id,
        crm_conversation_id: launch.crm_conversation_id ?? null,
      },
      customer: {
        display_name: launch.customer_display_name ?? null,
        phone: launch.customer_phone ?? null,
      },
    },
  });
}

async function handleTestLaunch(req: Request, requestId: string): Promise<Response> {
  const auth = await authenticate(req, "athos:launch:read");
  if (!auth.ok) {
    return reply(requestId, auth.status, {
      error: { code: auth.status === 403 ? "forbidden" : "unauthenticated", message: auth.message },
    });
  }

  const launchId = crypto.randomUUID();
  const contactId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { error } = await supabase.from("athos_sandbox_launches").insert({
    launch_id: launchId,
    connection_id: auth.connection.id,
    store_ref: auth.connection.store_ref,
    crm_contact_id: contactId,
    crm_conversation_id: null,
    customer_display_name: "Cliente Sandbox Athos",
    customer_phone: "+5511999999999",
    expires_at: expiresAt,
  });
  if (error) {
    return reply(requestId, 500, { error: { code: "internal_error", message: "launch_create_failed" } });
  }

  const menu = new URL(auth.connection.menu_url);
  menu.searchParams.set("launch_id", launchId);
  return reply(requestId, 201, {
    data: {
      environment: "sandbox",
      launch_id: launchId,
      expires_at: expiresAt,
      crm_contact_id: contactId,
      menu_url: menu.toString(),
    },
  });
}

async function handleEvents(req: Request, requestId: string): Promise<Response> {
  const auth = await authenticate(req, "athos:events:write");
  if (!auth.ok) {
    return reply(requestId, auth.status, {
      error: { code: auth.status === 403 ? "forbidden" : "unauthenticated", message: auth.message },
    });
  }

  const timestamp = req.headers.get("x-athos-timestamp") ?? "";
  if (
    !/^[0-9]{10}$/.test(timestamp) ||
    Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > REPLAY_WINDOW_SECONDS
  ) {
    return reply(requestId, 401, {
      error: { code: "unauthenticated", message: "invalid_or_expired_timestamp" },
    });
  }

  const rawBody = await req.text();
  const hmacSecret = await sha256Hex(`deskcomm-athos-sandbox-v1:${auth.bearer}`);
  const signatureOk = await verifyHmac(
    hmacSecret,
    `${timestamp}.${rawBody}`,
    req.headers.get("x-athos-signature"),
  );
  if (!signatureOk) {
    return reply(requestId, 401, { error: { code: "unauthenticated", message: "invalid_signature" } });
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(rawBody) as Record<string, any>;
  } catch {
    return reply(requestId, 400, { error: { code: "invalid_request", message: "invalid_json" } });
  }

  const invalid = validateEvent(event);
  if (invalid) {
    return reply(requestId, 422, {
      error: { code: "invalid_request", message: "event_outside_contract", details: invalid },
    });
  }
  if (event.store_ref !== auth.connection.store_ref) {
    return reply(requestId, 403, { error: { code: "forbidden", message: "store_not_allowed" } });
  }

  if (event.correlation?.launch_id) {
    const { data: launch, error: launchError } = await supabase
      .from("athos_sandbox_launches")
      .select("crm_contact_id")
      .eq("launch_id", event.correlation.launch_id)
      .eq("connection_id", auth.connection.id)
      .eq("store_ref", auth.connection.store_ref)
      .maybeSingle();
    if (launchError || !launch) {
      return reply(requestId, 422, { error: { code: "invalid_request", message: "launch_not_found" } });
    }
    if (event.correlation.crm_contact_id && event.correlation.crm_contact_id !== launch.crm_contact_id) {
      return reply(requestId, 422, {
        error: { code: "invalid_request", message: "correlation_mismatch" },
      });
    }
  }

  const { data: duplicate } = await supabase
    .from("athos_sandbox_events")
    .select("id")
    .eq("connection_id", auth.connection.id)
    .eq("event_id", event.event_id)
    .maybeSingle();
  if (duplicate) {
    return reply(requestId, 202, {
      data: { accepted: true, duplicate: true, event_id: event.event_id, environment: "sandbox" },
    });
  }

  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supabase
    .from("athos_sandbox_events")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", auth.connection.id)
    .gte("received_at", oneMinuteAgo);
  if ((count ?? 0) >= RATE_LIMIT_PER_MINUTE) {
    return reply(requestId, 429, { error: { code: "rate_limited", message: "rate_limit_exceeded" } });
  }

  const { data: receipt, error: insertError } = await supabase
    .from("athos_sandbox_events")
    .insert({
      connection_id: auth.connection.id,
      event_id: event.event_id,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      store_ref: event.store_ref,
      external_order_id: event.order.id,
      payload: event,
      status: "received",
    })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return reply(requestId, 202, {
        data: { accepted: true, duplicate: true, event_id: event.event_id, environment: "sandbox" },
      });
    }
    return reply(requestId, 500, { error: { code: "internal_error", message: "event_receipt_failed" } });
  }

  const { data: orderId, error: applyError } = await supabase.rpc(
    "fn_apply_athos_sandbox_order_snapshot",
    {
      p_connection_id: auth.connection.id,
      p_event: event,
    },
  );
  if (applyError || !orderId) {
    await supabase
      .from("athos_sandbox_events")
      .update({
        status: "error",
        processed_at: new Date().toISOString(),
        error_message: `apply_snapshot_failed:${applyError?.code ?? "no_order_id"}`,
      })
      .eq("id", receipt.id);
    return reply(requestId, 500, {
      error: { code: "internal_error", message: "event_processing_failed" },
    });
  }

  await supabase
    .from("athos_sandbox_events")
    .update({
      status: "processed",
      processed_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("id", receipt.id);

  return reply(requestId, 202, {
    data: {
      accepted: true,
      duplicate: false,
      event_id: event.event_id,
      order_id: orderId,
      environment: "sandbox",
    },
  });
}

Deno.serve(async (req: Request) => {
  const requestId = crypto.randomUUID();
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headers(requestId) });
  }

  try {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.lastIndexOf("athos-sandbox");
    const route = marker >= 0 ? parts.slice(marker + 1) : [];

    if (req.method === "GET" && route.length === 0) {
      return reply(requestId, 200, {
        data: { status: "ok", environment: "sandbox", service: "athos-sandbox" },
      });
    }
    if (req.method === "GET" && route[0] === "launches" && route[1]) {
      return handleGetLaunch(req, requestId, route[1]);
    }
    if (req.method === "POST" && route[0] === "test-launch" && route.length === 1) {
      return handleTestLaunch(req, requestId);
    }
    if (req.method === "POST" && route[0] === "events" && route.length === 1) {
      return handleEvents(req, requestId);
    }
    return reply(requestId, 404, { error: { code: "not_found", message: "route_not_found" } });
  } catch (error) {
    console.error(
      "[athos-sandbox] unhandled",
      error instanceof Error ? error.message : String(error),
    );
    return reply(requestId, 500, { error: { code: "internal_error", message: "internal_error" } });
  }
});

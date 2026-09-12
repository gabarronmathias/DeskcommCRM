import type { createAdminClient } from "@/lib/supabase/admin";
import type { WahaEnvelope, WahaPayload } from "@/lib/waha/ingest";
import { sendWAHA } from "@/lib/waha/send";

type Admin = ReturnType<typeof createAdminClient>;

interface AthosTestSession {
  id: string;
  organization_id: string;
  waha_session_name: string;
}

interface CommerceSettingsRow {
  app_name: string | null;
  settings: Record<string, unknown> | null;
  athos_store_ref: string | null;
}

const recentInbound = new Map<string, number>();
const DEDUPE_TTL_MS = 5 * 60 * 1000;

function elapsed(startedAt: number): number {
  return Date.now() - startedAt;
}

function logStage(
  stage: string,
  startedAt: number,
  details?: Record<string, unknown>,
): void {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[ATHOS-TEST] ${stage} +${elapsed(startedAt)}ms${suffix}`);
}

function logFailure(
  startedAt: number,
  stage: string,
  error: unknown,
): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error(
    `[ATHOS-TEST] outbound_failed +${elapsed(startedAt)}ms ${JSON.stringify({
      failed_stage: stage,
      error: normalized.message,
    })}`,
  );
  console.error(normalized.stack ?? normalized);
  console.error(`TOTAL: ${elapsed(startedAt)}ms`);
}

function inboundChatId(payload: WahaPayload): string | null {
  const extra = payload as WahaPayload & Record<string, unknown>;
  const candidate = [payload.from, extra.chatId, extra.fromNumber].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (!candidate) return null;
  if (candidate.includes("@")) return candidate;
  const digits = candidate.replace(/\D/g, "");
  return digits.length >= 8 ? `${digits}@c.us` : null;
}

function claimInbound(sessionId: string, payload: WahaPayload): boolean {
  const now = Date.now();
  for (const [key, timestamp] of recentInbound) {
    if (now - timestamp > DEDUPE_TTL_MS) recentInbound.delete(key);
  }
  if (!payload.id) return true;
  const key = `${sessionId}:${payload.id}`;
  if (recentInbound.has(key)) return false;
  recentInbound.set(key, now);
  return true;
}

function officialMenuUrl(row: CommerceSettingsRow | null): string | null {
  const value = row?.settings?.athos_menu_url;
  if (typeof value !== "string" || value.trim() === "") return null;
  const candidate = value.trim();
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Temporary phase-1 isolation path: inbound WhatsApp -> official Athos URL ->
 * WhatsApp. It deliberately does not invoke ingestion, CRM, automations, or
 * the Sarah/LLM runtime.
 */
export async function handleAthosTestInbound(
  admin: Admin,
  session: AthosTestSession,
  envelope: WahaEnvelope,
  startedAt = Date.now(),
): Promise<boolean> {
  const payload = envelope.payload ?? {};
  const chatId = inboundChatId(payload);
  if (!chatId) {
    const error = new Error("waha_inbound_chat_id_missing");
    logFailure(startedAt, "inbound_received", error);
    throw error;
  }
  if (!claimInbound(session.id, payload)) {
    console.log(
      `[ATHOS-TEST] duplicate_ignored +${elapsed(startedAt)}ms ${JSON.stringify({
        message_id: payload.id,
      })}`,
    );
    return false;
  }

  logStage("inbound_received", startedAt, {
    event: envelope.event ?? "unknown",
    message_id: payload.id ?? null,
    chat_id: chatId,
  });
  logStage("tenant_resolved", startedAt, {
    organization_id: session.organization_id,
    channel_session_id: session.id,
    waha_session: session.waha_session_name,
  });

  let row: CommerceSettingsRow | null;
  try {
    const result = await admin
      .from("food_commerce_settings")
      .select("app_name, settings, athos_store_ref")
      .eq("organization_id", session.organization_id)
      .eq("is_enabled", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) throw result.error;
    row = (result.data as CommerceSettingsRow | null) ?? null;
  } catch (error) {
    logFailure(startedAt, "menu_url_loaded", error);
    throw error;
  }

  const menuUrl = officialMenuUrl(row);
  if (!menuUrl) {
    const error = new Error("athos_menu_url_missing_or_invalid");
    logFailure(startedAt, "menu_url_loaded", error);
    throw error;
  }
  logStage("menu_url_loaded", startedAt, {
    organization_id: session.organization_id,
    tenant_name: row?.app_name ?? null,
    athos_store_ref: row?.athos_store_ref ?? null,
    menu_url: menuUrl,
  });

  const text = `Olá! 😊 Aqui está nosso cardápio:\n${menuUrl}`;
  logStage("outbound_started", startedAt, {
    chat_id: chatId,
    menu_url: menuUrl,
  });
  try {
    const sent = await sendWAHA({
      sessionName: session.waha_session_name,
      chatId,
      text,
    });
    if (!sent) throw new Error("waha_client_not_configured");
  } catch (error) {
    logFailure(startedAt, "outbound", error);
    throw error;
  }

  logStage("outbound_success", startedAt, {
    chat_id: chatId,
    menu_url: menuUrl,
  });
  console.error(`TOTAL: ${elapsed(startedAt)}ms`);
  return true;
}

/**
 * Thin WAHA send helper exposed for the agent runtime (S-13.08).
 *
 * The runtime uses `sendMessageHandler` for the production path (handles WAHA
 * dispatch + outbound message row + ack + retries), so this module is a small
 * convenience for direct callers (tests, smoke checks). Returns null when
 * WAHA env is not configured — callers must treat that as a noop, not error.
 */
import { getWahaClient } from "./client";

export interface SendWahaInput {
  sessionName: string;
  chatId: string;
  text: string;
  timeoutMs?: number;
}

export interface ResolveWahaChatIdInput {
  isGroup: boolean;
  groupChatId: string | null;
  phoneNumber: string | null | undefined;
  /** `contacts.wa_identity` (migration 0027): 'phone:+E164' | 'lid:<digits>' | null. */
  waIdentity: string | null | undefined;
}

/**
 * Resolves the WAHA-addressable chat id for a 1:1 or group conversation.
 * Falls back to the `lid:<digits>` identity (migration 0027) when the
 * contact has no `phone_number` — WhatsApp's privacy-mode contacts (Linked
 * ID) never expose a real phone number, but WAHA/NOWEB still accepts sending
 * to `<digits>@lid`.
 */
export function resolveWahaChatId(input: ResolveWahaChatIdInput): string | null {
  if (input.isGroup && input.groupChatId) return input.groupChatId;
  if (input.phoneNumber) return `${input.phoneNumber.replace(/\D/g, "")}@c.us`;
  if (input.waIdentity?.startsWith("lid:")) return `${input.waIdentity.slice(4)}@lid`;
  return null;
}

export async function sendWAHA(input: SendWahaInput): Promise<unknown | null> {
  const client = getWahaClient();
  if (!client) return null;
  return client.sendMessage(input.sessionName, input.chatId, input.text, input.timeoutMs);
}

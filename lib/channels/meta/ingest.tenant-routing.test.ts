import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestMetaInbound } from "./ingest";
import type { InboundMessageEvent } from "./webhook";

const ORG = "chopperia-org";
const SESSION = "meta-session";
const CONTACT = "org-contact";
const CONVERSATION = "org-conversation";

function makeAdmin() {
  const filters: Array<{ table: string; method: string; column: string; value: unknown }> = [];
  const writes: Array<{ table: string; value: unknown }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let table = "";
  let inserted: unknown;
  const resultForTerminal = () => ({
    data:
      table === "channel_sessions"
        ? { id: SESSION, organization_id: ORG }
        : table === "contacts"
          ? null
          : { id: "inbound-message" },
    error: null,
  });
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "in", "limit", "insert"]) {
    builder[method] = (...args: unknown[]) => {
      if (method === "insert") {
        inserted = args[0];
        writes.push({ table, value: inserted });
      }
      if (["eq", "is", "in"].includes(method)) {
        filters.push({ table, method, column: String(args[0]), value: args[1] });
      }
      return builder;
    };
  }
  builder.maybeSingle = vi.fn(async () => resultForTerminal());
  const admin = {
    from(name: string) {
      table = name;
      return builder;
    },
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return {
        data: name === "fn_upsert_wa_contact" ? CONTACT : CONVERSATION,
        error: null,
      };
    }),
  };
  return { admin: admin as unknown as SupabaseClient, filters, writes, rpcCalls };
}

describe("Meta inbound tenant routing", () => {
  it("deriva organização da sessão pelo phone_number_id antes de resolver contato", async () => {
    const db = makeAdmin();
    const event: InboundMessageEvent = {
      kind: "inbound_message",
      wabaId: "waba",
      phoneNumberId: "recipient-phone-number-id",
      externalId: "wamid-test",
      from: "5511932192207",
      profileName: "Contato de teste",
      sentAt: new Date("2026-11-26T12:00:00Z"),
      type: "text",
      text: "Oi",
      media: null,
    };

    await expect(ingestMetaInbound(db.admin, event)).resolves.toMatchObject({ status: "ingested" });
    expect(db.filters).toContainEqual({
      table: "channel_sessions",
      method: "eq",
      column: "meta_phone_number_id",
      value: event.phoneNumberId,
    });
    expect(db.filters).toContainEqual({
      table: "contacts",
      method: "eq",
      column: "organization_id",
      value: ORG,
    });
    expect(db.rpcCalls.slice(0, 2).map(({ args }) => args.p_org)).toEqual([ORG, ORG]);
    expect(db.rpcCalls[2]).toMatchObject({
      name: "fn_mark_conversation_message",
      args: { p_conv: CONVERSATION },
    });
    expect(db.writes).toContainEqual({
      table: "messages",
      value: expect.objectContaining({
        organization_id: ORG,
        channel_session_id: SESSION,
        contact_id: CONTACT,
        conversation_id: CONVERSATION,
      }),
    });
  });
});

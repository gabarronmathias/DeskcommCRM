import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { sendMessageHandler } from "./_handler";

describe("sendMessageHandler tenant guard", () => {
  it("does not resolve or send a conversation ID outside the active tenant", async () => {
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      }),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    const client = { from: vi.fn(() => query) } as unknown as SupabaseClient;
    const context: HandlerCtx = {
      organization_id: "tenant-a",
      actor: { type: "user", id: "user-a" },
      requestId: "request-test",
    };

    await expect(
      sendMessageHandler(client, context, {
        conversation_id: "11111111-1111-4111-8111-111111111111",
        type: "text",
        body: "teste",
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    expect(filters).toContainEqual(["organization_id", "tenant-a"]);
    expect(query.maybeSingle).toHaveBeenCalledOnce();
  });
});

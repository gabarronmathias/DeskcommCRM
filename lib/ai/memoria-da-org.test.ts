import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { publicarMemoriaDaOrg } from "./memoria-da-org";

describe("publicarMemoriaDaOrg", () => {
  it("reutiliza a versão atual quando o conteúdo já está publicado", async () => {
    const maybePointer = vi.fn().mockResolvedValue({ data: { version_id: "version-1" }, error: null });
    const maybeVersion = vi.fn().mockResolvedValue({
      data: { id: "version-1", version_number: 4, content: "Regras já publicadas" },
      error: null,
    });
    const insert = vi.fn();
    const upsert = vi.fn();
    const admin = {
      from: vi.fn((table: string) => table === "org_memory_pointers"
        ? { select: () => ({ eq: () => ({ maybeSingle: maybePointer }) }) }
        : {
            select: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle: maybeVersion }),
                order: () => ({ limit: () => ({ maybeSingle: vi.fn() }) }),
              }),
            }),
            insert,
            upsert,
          }),
    } as unknown as SupabaseClient;

    const result = await publicarMemoriaDaOrg(admin, "org-1", "user-1", "Regras já publicadas");

    expect(result).toEqual({
      ok: true,
      versionId: "version-1",
      versionNumber: 4,
      unchanged: true,
    });
    expect(insert).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { tenantScopedQueryKey } from "@/lib/query/tenant-scope";

describe("tenantScopedQueryKey", () => {
  it("mantém o mesmo recurso isolado em tenants diferentes", () => {
    expect(tenantScopedQueryKey(["messages", "conversation-1"], "tenant-a")).not.toEqual(
      tenantScopedQueryKey(["messages", "conversation-1"], "tenant-b"),
    );
  });

  it("preserva prefixos usados para invalidar famílias de consultas", () => {
    expect(
      tenantScopedQueryKey(["conversations", { status: "open" }], "tenant-a").slice(0, 1),
    ).toEqual(["conversations"]);
    expect(
      tenantScopedQueryKey(["conversation", "conversation-1"], "tenant-a").slice(0, 2),
    ).toEqual(["conversation", "conversation-1"]);
  });
});

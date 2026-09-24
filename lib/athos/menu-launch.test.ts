import { describe, expect, it, vi } from "vitest";
import { attachAthosLaunchToMenuLink } from "./menu-launch";

describe("attachAthosLaunchToMenuLink", () => {
  it("adds a fresh launch id to the configured Athos URL and persists its CRM correlation", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ store_metadata: {
        environment: "sandbox",
        menu_url: "https://cardapio.sistemaathos.com.br/tortasdocalmon",
        store_ref: "athos-store",
      } }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    const body = "Segue o cardápio: https://cardapio.sistemaathos.com.br/tortasdocalmon";

    const result = await attachAthosLaunchToMenuLink({
      pool: { query } as never,
      organizationId: "org-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      requestId: "job-1",
      body,
    });

    const url = new URL(result.split(": ")[1]!);
    expect(url.origin + url.pathname).toBe("https://cardapio.sistemaathos.com.br/tortasdocalmon");
    expect(url.searchParams.get("launch_id")).toMatch(/^[0-9a-f-]{36}$/i);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[1]).toEqual([
      url.searchParams.get("launch_id"), "org-1", "contact-1", "conversation-1", "athos-store",
      expect.any(String), expect.stringContaining("sarah_outbound_menu"),
    ]);
  });

  it("does not query or rewrite unrelated messages", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ store_metadata: {
      environment: "production",
      menu_url: "https://cardapio.sistemaathos.com.br/tortasdocalmon",
      store_ref: "athos-store",
    } }] });
    const body = "Oi! Posso ajudar.";
    await expect(attachAthosLaunchToMenuLink({
      pool: { query } as never,
      organizationId: "org-1",
      contactId: "contact-1",
      conversationId: "conversation-1",
      requestId: "job-1",
      body,
    })).resolves.toBe(body);
    expect(query).not.toHaveBeenCalled();
  });

  it("leaves the configured URL unchanged outside the sandbox", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ store_metadata: {
      environment: "production",
      menu_url: "https://cardapio.sistemaathos.com.br/tortasdocalmon",
      store_ref: "athos-store",
    } }] });
    const body = "https://cardapio.sistemaathos.com.br/tortasdocalmon";
    await expect(attachAthosLaunchToMenuLink({
      pool: { query } as never, organizationId: "org-1", contactId: "contact-1",
      conversationId: "conversation-1", requestId: "job-1", body,
    })).resolves.toBe(body);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

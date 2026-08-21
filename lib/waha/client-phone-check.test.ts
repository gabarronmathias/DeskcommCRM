import { afterEach, describe, expect, it, vi } from "vitest";

import { WahaClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("WahaClient.checkPhoneExists", () => {
  it("consulta o endpoint oficial e preserva o chatId real", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          numberExists: true,
          chatId: "987654321@lid",
          pn: "5512999990000@c.us",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WahaClient("https://waha.example", "secret").checkPhoneExists(
      "org_gb",
      "+55 (12) 99999-0000",
    );

    expect(result).toEqual({
      numberExists: true,
      chatId: "987654321@lid",
      pn: "5512999990000@c.us",
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://waha.example/api/contacts/check-exists?phone=5512999990000&session=org_gb",
    );
    expect(init.headers).toEqual({ "X-Api-Key": "secret" });
  });

  it("falha alto quando o WAHA não consegue validar", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("offline", { status: 503 })));
    await expect(
      new WahaClient("https://waha.example", "secret").checkPhoneExists("org_gb", "+5512999990000"),
    ).rejects.toThrow("waha_check_exists_503");
  });
});

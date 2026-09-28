import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { authenticateAthosPartner } from "@/lib/athos/partner-auth";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { McpAuthError } from "@/lib/mcp/auth";

vi.mock("@/lib/athos/partner-auth", () => ({ authenticateAthosPartner: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const orgId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const storeRef = "5b7b4a38-4c54-488e-986f-9ea0428cff7a";

function request(body: string, authorization = "Bearer dsk_test_token"): NextRequest {
  return new NextRequest("http://localhost/api/v1/partners/athos/test-launch", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body,
  });
}

function configureAdmin(overrides: { contactError?: boolean; launchError?: boolean } = {}) {
  const contactSingle = vi.fn().mockResolvedValue({
    data: overrides.contactError ? null : { id: contactId },
    error: overrides.contactError ? { message: "contact failure" } : null,
  });
  const contactSelect = vi.fn(() => ({ single: contactSingle }));
  const contactInsert = vi.fn(() => ({ select: contactSelect }));
  const launchInsert = vi.fn().mockResolvedValue({
    error: overrides.launchError ? { message: "launch failure" } : null,
  });
  const admin = {
    from: vi.fn((table: string) => table === "contacts"
      ? { insert: contactInsert }
      : { insert: launchInsert }),
  };
  vi.mocked(authenticateAthosPartner).mockResolvedValue({
    auth: { organizationId: orgId, apiTokenId: "token-1" } as never,
    admin: admin as never,
    integration: { organization_id: orgId } as never,
    storeRef,
  } as never);
  return { admin, contactInsert, launchInsert };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 10, window_sec: 3600 });
});

describe("POST /api/v1/partners/athos/test-launch", () => {
  it("creates an isolated sandbox contact and a ten-minute launch", async () => {
    const { contactInsert, launchInsert } = configureAdmin();
    const { POST } = await import("./route");
    const before = Date.now();
    const response = await POST(request(JSON.stringify({ store_ref: storeRef })));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(authenticateAthosPartner).toHaveBeenCalledWith("Bearer dsk_test_token", "athos:events:write");
    expect(checkRateLimit).toHaveBeenCalledWith(`athos:test-launch:${orgId}:token-1`, 10, 3600);
    expect(contactInsert).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: orgId, is_blocked: true,
      source_metadata: { source: "athos_partner_test_launch" },
    }));
    expect(launchInsert).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: orgId, provider: "athos", contact_id: contactId,
      conversation_id: null, store_ref: storeRef,
    }));
    expect(payload.data).toEqual(expect.objectContaining({
      environment: "sandbox", crm_contact_id: contactId,
      crm_conversation_id: null, store_ref: storeRef,
      launch_id: expect.any(String), expires_at: expect.any(String),
    }));
    expect(new Date(payload.data.expires_at).getTime()).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "athos.launch.created", actorApiTokenId: "token-1",
      organizationId: orgId, resourceId: payload.data.launch_id,
    }));
  });

  it("does not create records for a different store", async () => {
    const { admin } = configureAdmin();
    const { POST } = await import("./route");
    const response = await POST(request(JSON.stringify({ store_ref: "another-store" })));
    expect(response.status).toBe(403);
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("rejects malformed input before writing", async () => {
    const { admin } = configureAdmin();
    const { POST } = await import("./route");
    expect((await POST(request("{"))).status).toBe(400);
    expect((await POST(request(JSON.stringify({ store_ref: storeRef, extra: true })))).status).toBe(400);
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("limits sandbox launch creation before any database write", async () => {
    const { admin } = configureAdmin();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 11, limit: 10, window_sec: 3600 });
    const { POST } = await import("./route");
    const response = await POST(request(JSON.stringify({ store_ref: storeRef })));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(admin.from).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid partner authentication", async () => {
    vi.mocked(authenticateAthosPartner).mockRejectedValue(new McpAuthError(-32001, 401, "Token not recognized."));
    const { POST } = await import("./route");
    const response = await POST(request(JSON.stringify({ store_ref: storeRef }), "Bearer dsk_invalid"));
    expect(response.status).toBe(401);
  });

  it("reports contact or launch persistence failures without claiming success", async () => {
    const { POST } = await import("./route");
    configureAdmin({ contactError: true });
    expect((await POST(request(JSON.stringify({ store_ref: storeRef })))).status).toBe(500);
    configureAdmin({ launchError: true });
    expect((await POST(request(JSON.stringify({ store_ref: storeRef })))).status).toBe(500);
  });
});


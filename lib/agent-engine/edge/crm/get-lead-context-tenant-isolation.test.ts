import { describe, expect, it } from "vitest";
import type { Queryable } from "../../queue/queue";
import { getLeadContext } from "./get-lead-context";

const TENANT_A = "chopperia";
const TENANT_B = "tortas";
const SAME_PHONE = "+5511932192207";

function databaseForTenant(tenantId: string, ownerContactId: string) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("from contacts")) {
        if (params[0] !== tenantId) return { rows: [] };
        return {
          rows: [
            {
              name: null,
              display_name: tenantId,
              email: null,
              phone_number: SAME_PHONE,
              tags: [],
              is_blocked: false,
              source: "whatsapp",
              consent: null,
              is_anonymized: false,
            },
          ],
        };
      }
      if (sql.includes("from conversations")) {
        if (params[0] !== tenantId || params[1] !== ownerContactId) return { rows: [] };
        return { rows: [{ id: `${tenantId}-conversation` }] };
      }
      if (sql.includes("from crm_lead_activities")) return { rows: [] };
      if (sql.includes("from messages")) {
        if (params[0] !== tenantId || params[1] !== `${tenantId}-conversation`) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              direction: "inbound",
              sent_via: null,
              type: "text",
              body: tenantId === TENANT_A ? "Pizza" : "Torta",
              media_url: null,
              media_storage_path: null,
              media_mime: null,
              media_derived_text: null,
              sent_at: "2026-11-26T12:00:00Z",
            },
          ],
        };
      }
      throw new Error(`Query inesperada no teste: ${sql}`);
    },
  };
  return { db: db as unknown as Queryable, calls };
}

describe("getLeadContext — telefone igual em tenants diferentes", () => {
  it("mantém contato, conversa e histórico isolados pelo tenant do job", async () => {
    const crmCfg = {} as Parameters<typeof getLeadContext>[1];
    const knobs = { historyLimit: 20, maxTokens: 1000 };
    const tenantA = databaseForTenant(TENANT_A, "contact-a");
    const tenantB = databaseForTenant(TENANT_B, "contact-b");

    const [a, b] = await Promise.all([
      getLeadContext(tenantA.db, crmCfg, { tenantId: TENANT_A, leadId: "contact-a" }, knobs),
      getLeadContext(tenantB.db, crmCfg, { tenantId: TENANT_B, leadId: "contact-b" }, knobs),
    ]);

    expect(a.ok && a.context.messages.map((message) => message.body)).toEqual(["Pizza"]);
    expect(b.ok && b.context.messages.map((message) => message.body)).toEqual(["Torta"]);
    for (const { sql, params } of [...tenantA.calls, ...tenantB.calls]) {
      expect(sql).toMatch(/organization_id\s*=\s*\$1/);
      expect(params[0] === TENANT_A || params[0] === TENANT_B).toBe(true);
    }
    expect(tenantA.calls.every(({ params }) => params[0] === TENANT_A)).toBe(true);
    expect(tenantB.calls.every(({ params }) => params[0] === TENANT_B)).toBe(true);
  });

  it("recusa conversationId válida de outro contato antes de ler o histórico", async () => {
    const tenant = databaseForTenant(TENANT_A, "contact-a");
    const result = await getLeadContext(
      tenant.db,
      {} as Parameters<typeof getLeadContext>[1],
      {
        tenantId: TENANT_A,
        leadId: "contact-other",
        conversationId: `${TENANT_A}-conversation`,
      },
      { historyLimit: 20, maxTokens: 1000 },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "conversation_not_found" } });
    expect(tenant.calls.some(({ sql }) => sql.includes("from messages"))).toBe(false);
  });
});

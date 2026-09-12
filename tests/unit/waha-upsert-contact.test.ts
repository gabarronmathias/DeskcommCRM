import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { upsertContact, type ChatIdentity } from "@/lib/waha/ingest";

// ---------------------------------------------------------------------------
// Mock de admin baseado em FILTRO.
//
// O helper constrói cada nível de identidade com chain diferente:
//   Nível 1 (wa_lid):     .eq("wa_lid", X)          (sem .or)
//   Nível 2 (lid_legacy): .or("wa_identity.eq.lid:X,source_metadata->>waha_lid.eq.X")
//   Nível 3 (phone):      .or("phone_number.eq.X,wa_identity.eq.phone:X")
//
// O mock identifica o nível pelo .or() filter (ou ausência dele pra nível 1).
// Lookup do canônico via .eq("id", X).maybeSingle().
// ---------------------------------------------------------------------------

type RpcResult = (fn: string, args: Record<string, unknown>) =>
  { data: string | null; error: { code?: string; message: string } | null };

type ContactRow = { id: string; is_merged_into?: string | null };
type LevelResponse = { data: ContactRow[]; error: { message: string } | null };
type CanonicalResponse = { data: ContactRow | null; error: { message: string } | null };

interface MockConfig {
  rpcResult?: RpcResult;
  /** Resposta do nível 1 (wa_lid coluna, sem .or). */
  wa_lid?: LevelResponse;
  /** Resposta do nível 2 (LID legado via .or wa_identity/source_metadata). */
  lid_legacy?: LevelResponse;
  /** Resposta do nível 3 (telefone via .or phone_number/wa_identity). */
  phone?: LevelResponse;
  /** Lookup do canônico: id → response. Recursivo até depth 5. */
  byCanonical?: (id: string, depth: number) => CanonicalResponse;
}

function buildAdmin(config: MockConfig) {
  const calls = {
    rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    limitByLevel: [] as Array<{ level: "wa_lid" | "lid_legacy" | "phone"; count: number }>,
    canonicalLookups: [] as Array<{ id: string; depth: number }>,
  };

  let lastOrFilter: string | null = null;
  let lastIdLookup: string | null = null;

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (_col: string, val?: string) => {
      if (_col === "id" && typeof val === "string") lastIdLookup = val;
      return builder;
    },
    or: (filter: string) => {
      lastOrFilter = filter;
      return builder;
    },
    limit: async (_n: number) => {
      // Identifica nível pelo .or() filter:
      //   null       → nível 1 (wa_lid)
      //   wa_identity|source_metadata  → nível 2 (lid_legacy)
      //   phone_number|wa_identity  → nível 3 (phone)
      let level: "wa_lid" | "lid_legacy" | "phone";
      if (lastOrFilter === null) level = "wa_lid";
      else if (lastOrFilter.includes("source_metadata")) level = "lid_legacy";
      else level = "phone";

      const response = config[level] ?? { data: [], error: null };
      calls.limitByLevel.push({ level, count: response.data?.length ?? 0 });
      lastOrFilter = null;
      return response;
    },
    maybeSingle: async () => {
      if (lastIdLookup !== null) {
        const captured = lastIdLookup;
        const depth = calls.canonicalLookups.filter((c) => c.id === captured).length;
        calls.canonicalLookups.push({ id: captured, depth });
        lastIdLookup = null;

        if (depth >= 5) {
          return { data: null, error: { message: `merge chain too deep at ${captured} (depth ${depth})` } };
        }
        if (config.byCanonical) return config.byCanonical(captured, depth);
        return { data: { id: captured }, error: null };
      }
      return { data: null, error: null };
    },
  };

  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push({ fn, args });
      return config.rpcResult ? config.rpcResult(fn, args) : { data: "contato-novo", error: null };
    },
    from: (_table: string) => {
      // Reset estado pra esta chain
      lastOrFilter = null;
      lastIdLookup = null;
      return builder;
    },
  };

  return { admin, calls };
}

const SESSION = { id: "sessao-1", organization_id: "org-A" };
const LID_PARSED: ChatIdentity = { kind: "lid", phone: null, lid: "5511999000001" };
const PHONE_PARSED: ChatIdentity = { kind: "phone", phone: "+5511999000002", lid: null };

// ---------------------------------------------------------------------------
// PRECEDÊNCIA
// ---------------------------------------------------------------------------

describe("upsertContact — precedência", () => {
  it("contato A casa por wa_lid exato, B casa por telefone e é mais antigo → retorna A", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      wa_lid: { data: [{ id: "contato-A-wa-lid" }], error: null },
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-A-wa-lid");
    const levelsCalled = calls.limitByLevel.map((c) => c.level);
    expect(levelsCalled).not.toContain("phone");
  });

  it("kind=lid sem coluna wa_lid, com LID legado → nível 2 acha", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      wa_lid: { data: [], error: null },
      lid_legacy: { data: [{ id: "contato-A-legado" }], error: null },
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-A-legado");
    expect(calls.limitByLevel.length).toBe(2);
    expect(calls.limitByLevel[1]?.level).toBe("lid_legacy");
  });

  it("kind=phone, níveis 1 e 2 skipped → só nível 3 (telefone) é tentado", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      phone: { data: [{ id: "contato-por-telefone" }], error: null },
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, PHONE_PARSED, "5511999000002@c.us", null);

    expect(id).toBe("contato-por-telefone");
    expect(calls.limitByLevel.length).toBe(1);
    expect(calls.limitByLevel[0]?.level).toBe("phone");
  });
});

// ---------------------------------------------------------------------------
// MÚLTIPLOS MATCHES — convergência e ambiguidade
// ---------------------------------------------------------------------------

describe("upsertContact — múltiplos matches por identidade", () => {
  it("uma linha ativa por wa_lid → retorna ela", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      wa_lid: { data: [{ id: "active-A" }], error: null },
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);
    expect(id).toBe("active-A");
  });

  it("uma linha mergeada → retorna canônico", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      wa_lid: { data: [{ id: "merged-A", is_merged_into: "canonical-C" }], error: null },
      byCanonical: (id) => {
        if (id === "canonical-C") return { data: { id: "canonical-C" }, error: null };
        return { data: null, error: null };
      },
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);
    expect(id).toBe("canonical-C");
  });

  it("duas linhas mergeadas apontando para o MESMO canônico → retorna canônico, sem erro", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      wa_lid: {
        data: [
          { id: "merged-A", is_merged_into: "canonical-C" },
          { id: "merged-B", is_merged_into: "canonical-C" },
        ],
        error: null,
      },
      byCanonical: (id) => {
        if (id === "canonical-C") return { data: { id: "canonical-C" }, error: null };
        return { data: null, error: null };
      },
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);
    expect(id).toBe("canonical-C");
  });

  it("duas linhas com mesmo wa_lid convergindo para canônicos DIFERENTES → CONTACT_IDENTITY_CONFLICT", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      wa_lid: {
        data: [
          { id: "merged-A", is_merged_into: "canonical-C" },
          { id: "merged-B", is_merged_into: "canonical-D" },
        ],
        error: null,
      },
      byCanonical: (id) => {
        if (id === "canonical-C" || id === "canonical-D") return { data: { id }, error: null };
        return { data: null, error: null };
      },
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/CONTACT_IDENTITY_CONFLICT/);
  });

  it("mesmo comportamento para nível LID legado: ambiguidade bloqueia", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      wa_lid: { data: [], error: null },
      lid_legacy: {
        data: [
          { id: "merged-A", is_merged_into: "canonical-C" },
          { id: "merged-B", is_merged_into: "canonical-D" },
        ],
        error: null,
      },
      byCanonical: (id) => {
        if (id === "canonical-C" || id === "canonical-D") return { data: { id }, error: null };
        return { data: null, error: null };
      },
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/CONTACT_IDENTITY_CONFLICT/);
  });

  it("telefone continua sendo nível inferior e nunca vence wa_lid", async () => {
    let phoneQueried = false;
    const phoneSpy: LevelResponse = {
      get data() {
        phoneQueried = true;
        return [{ id: "contato-por-telefone" }];
      },
      error: null,
    } as LevelResponse;
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      wa_lid: { data: [{ id: "contato-por-wa-lid" }], error: null },
      phone: phoneSpy,
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-por-wa-lid");
    expect(phoneQueried).toBe(false); // nível 3 não foi executado pra kind=lid
    expect(calls.limitByLevel.find((c) => c.level === "phone")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LOOKUP_FAILED vs LOOKUP_NOT_FOUND
// ---------------------------------------------------------------------------

describe("upsertContact — classificação de erro", () => {
  it("LOOKUP_FAILED no nível 1 propaga", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      wa_lid: { data: [], error: { message: "timeout expired" } },
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/wa_lid lookup failed/);
  });

  it("LOOKUP_NOT_FOUND em todos os níveis → 'contact upsert race'", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/contact upsert race/);
  });

  it("Erro NÃO-23505 propaga sem tentar lookup", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "42P10", message: 'column "wa_lid" does not exist' },
      }),
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/waha contact upsert failed/);
    expect(calls.limitByLevel.length).toBe(0);
  });

  it("LOOKUP_FAILED no canônico propaga", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      wa_lid: { data: [{ id: "merged-A", is_merged_into: "canonical-C" }], error: null },
      byCanonical: () => ({ data: null, error: { message: "timeout expired" } }),
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/canonical lookup failed/);
  });
});

// ---------------------------------------------------------------------------
// Casos gerais
// ---------------------------------------------------------------------------

describe("upsertContact — casos gerais", () => {
  it("wa_lid novo — RPC sucesso, sem nenhum lookup", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({ data: "contato-novo", error: null }),
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-novo");
    expect(calls.limitByLevel.length).toBe(0);
  });

  it("Race: duas chamadas simultâneas retornam o mesmo contact_id", async () => {
    let rpcCount = 0;
    const { admin } = buildAdmin({
      rpcResult: (fn) => {
        if (fn !== "fn_upsert_wa_contact") return { data: "conv-1", error: null };
        rpcCount++;
        if (rpcCount === 1) return { data: "contato-vencedor", error: null };
        return {
          data: null,
          error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
        };
      },
      wa_lid: { data: [{ id: "contato-vencedor" }], error: null },
    });

    const [idA, idB] = await Promise.all([
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ]);

    expect(idA).toBe("contato-vencedor");
    expect(idB).toBe("contato-vencedor");
  });
});

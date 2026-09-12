import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { upsertContact, type ChatIdentity } from "@/lib/waha/ingest";

// ---------------------------------------------------------------------------
// Mock de admin: encadeia tudo que o ingest.ts chama em cima de .from("contacts").
// A decisão do que devolver fica registrada nos arrays de "calls":
//   - contactLookups: recebe o filtro do .or(...) — uma chamada por upsertContact
//   - canonicalLookups: recebe o id passado em .eq("id", ...) — uma chamada se merge
// O mock decide o que retornar com base no que foi configurado pelo teste.
// ---------------------------------------------------------------------------

type RpcResult = (fn: string, args: Record<string, unknown>) =>
  { data: string | null; error: { code?: string; message: string } | null };

interface MockConfig {
  rpcResult?: RpcResult;
  /** Resposta do .or(...).maybeSingle() — chamado 1x por upsertContact com 23505. */
  contactLookup?: (filter: string) => { data: ContactRow | null; error: { message: string } | null };
  /** Resposta do .eq("id", X).maybeSingle() — chamado quando is_merged_into != null. */
  canonicalLookup?: (id: string) => { data: { id: string } | null; error: { message: string } | null };
}

type ContactRow = { id: string; is_merged_into?: string | null };

function buildAdmin(config: MockConfig) {
  const calls = {
    rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    contactLookups: [] as string[],
    canonicalLookups: [] as string[],
  };

  // Builder ÚNICO compartilhado (não função) — assim lastOrFilter/lastIdLookup
  // persistem ao longo do encadeamento (.select().eq().or().order().limit().maybeSingle()).
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
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => {
      // Se foi chamado .eq("id", X), é o lookup do canônico
      if (lastIdLookup !== null) {
        calls.canonicalLookups.push(lastIdLookup);
        const captured = lastIdLookup;
        lastIdLookup = null;
        if (config.canonicalLookup) return config.canonicalLookup(captured);
        return { data: null, error: null };
      }
      // Se foi chamado .or(F), é o lookup expandido
      if (lastOrFilter !== null) {
        calls.contactLookups.push(lastOrFilter);
        const captured = lastOrFilter;
        lastOrFilter = null;
        if (config.contactLookup) return config.contactLookup(captured);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
  };

  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push({ fn, args });
      return config.rpcResult
        ? config.rpcResult(fn, args)
        : { data: "contato-novo", error: null };
    },
    from: (_table: string) => builder,
  };

  return { admin, calls };
}

const SESSION = { id: "sessao-1", organization_id: "org-A" };
const LID_PARSED: ChatIdentity = { kind: "lid", phone: null, lid: "5511999000001" };
const PHONE_PARSED: ChatIdentity = { kind: "phone", phone: "+5511999000002", lid: null };

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

describe("upsertContact — recuperação de unique violation por identidade", () => {
  it("Caso 1: contato já existe com mesmo org + wa_lid (constraint uniq_contacts_org_wa_lid)", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      contactLookup: () => ({ data: { id: "contato-existente" }, error: null }),
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-existente");
  });

  it("Caso 2: wa_lid novo — RPC retorna sucesso direto, sem lookup", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({ data: "contato-novo", error: null }),
      contactLookup: () => {
        throw new Error("lookup não deveria ter sido chamado");
      },
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-novo");
  });

  it("Caso 3: lookup expandido encontra por qualquer um dos 3 caminhos de identidade (lid)", async () => {
    // O contato existe, lookup retorna — qual caminho achou é detalhe do banco.
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      contactLookup: () => ({ data: { id: "contato-por-identity" }, error: null }),
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-por-identity");
    // Confirma que o filtro cobre todos os caminhos de identidade lid
    expect(calls.contactLookups).toHaveLength(1);
    const filter = calls.contactLookups[0];
    expect(filter).toContain("wa_lid.eq.5511999000001");
    expect(filter).toContain("source_metadata->>waha_lid.eq.5511999000001");
    expect(filter).toContain("wa_identity.eq.lid:5511999000001");
  });

  it("Caso 4: contato encontrado está mergeado — retorna o canônico, não o mergeado", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      contactLookup: () => ({
        data: { id: "contato-mergeado", is_merged_into: "contato-canonico" },
        error: null,
      }),
      canonicalLookup: (id) =>
        id === "contato-canonico"
          ? { data: { id: "contato-canonico" }, error: null }
          : { data: null, error: null },
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-canonico");
  });

  it("Caso 5: lookup pós-23505 falha (LOOKUP_FAILED) — propaga erro, não cria contato às cegas", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      contactLookup: () => ({ data: null, error: { message: "timeout expired" } }),
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/contact identity lookup failed/);
  });

  it("Caso 6: lookup pós-23505 retorna null (LOOKUP_NOT_FOUND genuíno) — não cria contato", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      contactLookup: () => ({ data: null, error: null }),
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/contact upsert race/);
  });

  it("Caso 7: erro NÃO é 23505 — propaga sem tentar lookup", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "42P10", message: 'column "wa_lid" does not exist' },
      }),
      contactLookup: () => {
        throw new Error("lookup não deveria ter sido chamado para erro não-23505");
      },
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/waha contact upsert failed/);
  });

  it("Caso 8: chatId com sufixo @lid — o lookup usa só os dígitos", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      contactLookup: () => ({ data: { id: "contato-normalizado" }, error: null }),
    });

    const id = await upsertContact(
      admin as never,
      SESSION.organization_id,
      LID_PARSED,
      "5511999000001@lid",
      null,
    );

    expect(id).toBe("contato-normalizado");
    const filter = calls.contactLookups[0];
    // O filtro NUNCA contém o sufixo @c.us/@lid — só dígitos e o prefixo lid:
    expect(filter).not.toMatch(/@c\.us|@lid/);
    expect(filter).toContain("5511999000001");
  });

  it("Caso 9: kind=phone — lookup cobre phone_number E wa_identity='phone:+E164'", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_id"' },
      }),
      contactLookup: () => ({ data: { id: "contato-por-telefone" }, error: null }),
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, PHONE_PARSED, "5511999000002@c.us", null);

    expect(id).toBe("contato-por-telefone");
    const filter = calls.contactLookups[0];
    expect(filter).toContain("phone_number.eq.+5511999000002");
    expect(filter).toContain("wa_identity.eq.phone:+5511999000002");
  });

  it("Caso 10: race condition entre message e message.any — uma RPC vence, outra recebe 23505 e recupera", async () => {
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
      contactLookup: () => ({ data: { id: "contato-vencedor" }, error: null }),
    });

    const [idA, idB] = await Promise.all([
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ]);

    // Ambos retornam o mesmo id (sem duplicação)
    expect(idA).toBe("contato-vencedor");
    expect(idB).toBe("contato-vencedor");
  });
});

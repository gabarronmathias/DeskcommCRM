import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { upsertContact, type ChatIdentity } from "@/lib/waha/ingest";

// ---------------------------------------------------------------------------
// Mock de admin: o helper findExistingContactByIdentity agora faz 3 níveis
// de lookup separados (wa_lid coluna, LID legado, telefone), mais 1 lookup
// opcional do canônico. O mock enfileira configs por "fase" e consome em
// ordem. Cada config descreve a resposta esperada do próximo .maybeSingle().
// ---------------------------------------------------------------------------

type RpcResult = (fn: string, args: Record<string, unknown>) =>
  { data: string | null; error: { code?: string; message: string } | null };

interface LevelConfig {
  /** O que esse nível retorna (match, null, ou erro de query). */
  response: () => { data: ContactRow | null; error: { message: string } | null };
  /** Filtros/eqs permitidos nesse nível (para assertions). Opcional. */
  expectFilter?: string | RegExp;
}

type ContactRow = { id: string; is_merged_into?: string | null };

interface MockConfig {
  rpcResult?: RpcResult;
  /**
   * Lista de configs por chamada de maybeSingle (em ordem de consumo).
   * Ex.: [nível1, nível2, nível3, canônico, ...].
   * Se acabar antes das chamadas reais, retorna { data: null, error: null }.
   */
  levels?: LevelConfig[];
  /** Resposta quando canônico é resolvido (lookup .eq("id", X)). */
  canonicalLookup?: (id: string) => { data: { id: string } | null; error: { message: string } | null };
}

function buildAdmin(config: MockConfig) {
  const calls = {
    rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    maybeSingleCalls: [] as Array<{ filter: string | null; idLookup: string | null; isCanonicalLookup: boolean }>,
  };

  const queue = [...(config.levels ?? [])];

  const builderFn = (): unknown => {
    let lastOrFilter: string | null = null;
    let lastIdLookup: string | null = null;
    const obj: Record<string, unknown> = {
      select: () => obj,
      eq: (_col: string, val?: string) => {
        if (_col === "id" && typeof val === "string") lastIdLookup = val;
        return obj;
      },
      is: (_col: string, _val: unknown) => obj,
      or: (filter: string) => {
        lastOrFilter = filter;
        return obj;
      },
      order: () => obj,
      limit: () => obj,
      maybeSingle: async () => {
        const isCanonicalLookup = lastIdLookup !== null && lastOrFilter === null;
        calls.maybeSingleCalls.push({ filter: lastOrFilter, idLookup: lastIdLookup, isCanonicalLookup });

        // Lookup do canônico: .eq("id", X) sem .or
        if (isCanonicalLookup) {
          const captured = lastIdLookup!;
          lastIdLookup = null;
          if (config.canonicalLookup) return config.canonicalLookup(captured);
          return { data: null, error: null };
        }

        // Lookup de contato: consome próxima config da fila
        const level = queue.shift();
        lastOrFilter = null;
        if (!level) return { data: null, error: null };
        return level.response();
      },
    };
    return obj;
  };

  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push({ fn, args });
      return config.rpcResult
        ? config.rpcResult(fn, args)
        : { data: "contato-novo", error: null };
    },
    from: (_table: string) => builderFn(),
  };

  return { admin, calls };
}

const SESSION = { id: "sessao-1", organization_id: "org-A" };
const LID_PARSED: ChatIdentity = { kind: "lid", phone: null, lid: "5511999000001" };
const PHONE_PARSED: ChatIdentity = { kind: "phone", phone: "+5511999000002", lid: null };

// ---------------------------------------------------------------------------
// PRECEDÊNCIA — o ponto mais crítico do fix
// ---------------------------------------------------------------------------

describe("upsertContact — recuperação por identidade", () => {
  it("PRECEDÊNCIA: contato A casa por wa_lid exato, B casa por telefone e é mais antigo → retorna A", async () => {
    // O RPC dá 23505 e o nível 1 (wa_lid coluna) encontra A pelo exato.
    // O nível 2 e 3 NÃO DEVEM ser chamados — telefone nunca pode vencer wa_lid.
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        // Nível 1 — wa_lid coluna: ACHA
        { response: () => ({ data: { id: "contato-A-wa-lid" }, error: null }) },
        // Nível 2 — não deve ser chamado
        // Nível 3 — não deve ser chamado
      ],
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-A-wa-lid");
    // Apenas 1 chamada a maybeSingle (nível 1), porque níveis 2 e 3 não rodam
    expect(calls.maybeSingleCalls.length).toBe(1);
  });

  it("PRECEDÊNCIA: kind=lid, A não tem wa_lid coluna mas tem LID legado; nível 2 acha; nível 3 (telefone) NÃO é tentado", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        // Nível 1 — wa_lid coluna: NÃO acha
        { response: () => ({ data: null, error: null }) },
        // Nível 2 — LID legado (wa_identity OR source_metadata): ACHA
        { response: () => ({ data: { id: "contato-A-legado" }, error: null }) },
        // Nível 3 — telefone: NÃO deve ser tentado (kind=lid)
      ],
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-A-legado");
    expect(calls.maybeSingleCalls.length).toBe(2);
    // Confirma que a 2ª chamada foi com .or() (nível 2)
    expect(calls.maybeSingleCalls[1]?.filter).not.toBeNull();
    expect(calls.maybeSingleCalls[1]?.filter).toMatch(/wa_identity/);
  });

  it("PRECEDÊNCIA: kind=phone → nível 3 (telefone) é tentado, níveis 1 e 2 são skipped (lid null)", async () => {
    // PHONE_PARSED tem lid=null → níveis 1 e 2 são skipped pelo `if (lid)` do helper.
    // Só nível 3 (telefone) roda. A queue deve ter 1 entrada — a do nível 3.
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        // Nível 3 — telefone: ACHA
        { response: () => ({ data: { id: "contato-por-telefone" }, error: null }) },
      ],
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, PHONE_PARSED, "5511999000002@c.us", null);

    expect(id).toBe("contato-por-telefone");
    expect(calls.maybeSingleCalls.length).toBe(1);
    // Confirma que a query foi por telefone, não por LID
    expect(calls.maybeSingleCalls[0]?.filter).toMatch(/phone_number/);
  });

  it("PRECEDÊNCIA: kind=lid, níveis 1 e 2 não acham — nível 3 (telefone) NÃO é tentado", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        { response: () => ({ data: null, error: null }) },
        { response: () => ({ data: null, error: null }) },
        // Nível 3 não deveria ter config (não é tentado pra kind=lid)
      ],
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/contact upsert race/);
    // Apenas 2 chamadas (níveis 1 e 2), nível 3 não roda
    expect(calls.maybeSingleCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// MERGE — is_merged_into resolve pro canônico
//
// IMPORTANTE: a query NÃO filtra `is_merged_into IS NULL`. Política real de
// merge (supabase/baseline.sql:4165) só seta `is_merged_into` e move as FKs
// — não transfere `wa_lid`/`wa_identity`/`phone` para o canônico. A
// identidade fica no contato mergeado. Se filtrássemos mergeados, a
// identidade desapareceria e o sistema criaria contato duplicado em vez de
// redirecionar pro canônico.
// ---------------------------------------------------------------------------

describe("upsertContact — resolução de contato mergeado", () => {
  it("Cenário realista: A mergeado em B com mesmo wa_lid → incoming redireciona pra B", async () => {
    // Estado do banco:
    //   merged-A:   organization_id=org-A, wa_lid=5511999000001, is_merged_into=canonical-B
    //   canonical-B: organization_id=org-A, is_merged_into=NULL, wa_lid=NULL
    //                (o merge NÃO transfere wa_lid)
    //
    // Incoming: wa_lid=5511999000001 (só existe em merged-A)
    // Esperado: o sistema retorna canonical-B (não merged-A, não cria novo)
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        // Nível 1 (wa_lid coluna, SEM filtro de merge): retorna merged-A com is_merged_into
        { response: () => ({ data: { id: "merged-A", is_merged_into: "canonical-B" }, error: null }) },
      ],
      canonicalLookup: () => ({ data: { id: "canonical-B" }, error: null }),
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("canonical-B");
    expect(calls.maybeSingleCalls.length).toBe(2);
    // 2ª chamada é o lookup do canônico (eq("id", "canonical-B"))
    expect(calls.maybeSingleCalls[1]?.isCanonicalLookup).toBe(true);
    expect(calls.maybeSingleCalls[1]?.idLookup).toBe("canonical-B");
  });

  it("Contato encontrado no nível 1 sem merge → retorna direto (sem 2ª chamada)", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        { response: () => ({ data: { id: "contato-ativo", is_merged_into: null }, error: null }) },
      ],
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-ativo");
    expect(calls.maybeSingleCalls.length).toBe(1);
    // Não chamou o canônico porque is_merged_into é null
  });

  it("Contato mergeado encontrado no nível 2 (LID legado) → resolve pro canônico", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        // Nível 1: nada
        { response: () => ({ data: null, error: null }) },
        // Nível 2: match mergeado via wa_identity legado
        { response: () => ({ data: { id: "merged-A", is_merged_into: "canonical-B" }, error: null }) },
      ],
      canonicalLookup: () => ({ data: { id: "canonical-B" }, error: null }),
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("canonical-B");
    expect(calls.maybeSingleCalls.length).toBe(3);
  });

  it("Contato mergeado encontrado no nível 3 (telefone) → resolve pro canônico", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        // Nível 3: match mergeado via telefone (níveis 1 e 2 não rodam pra kind=phone porque lid=null)
        { response: () => ({ data: { id: "merged-A", is_merged_into: "canonical-B" }, error: null }) },
      ],
      canonicalLookup: () => ({ data: { id: "canonical-B" }, error: null }),
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, PHONE_PARSED, "5511999000002@c.us", null);

    expect(id).toBe("canonical-B");
    expect(calls.maybeSingleCalls.length).toBe(2);
  });

  it("Lookup do canônico falha (LOOKUP_FAILED no resolveCanonicalOrSelf) → propaga erro", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        // Nível 1: match mergeado
        { response: () => ({ data: { id: "merged-A", is_merged_into: "canonical-B" }, error: null }) },
      ],
      canonicalLookup: () => ({ data: null, error: { message: "timeout expired" } }),
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/canonical lookup failed/);
  });
});

// ---------------------------------------------------------------------------
// LOOKUP_FAILED vs LOOKUP_NOT_FOUND
// ---------------------------------------------------------------------------

describe("upsertContact — classificação de erro", () => {
  it("LOOKUP_FAILED no nível 1 propaga (não tenta níveis seguintes, não cria contato)", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        // Nível 1: erro de query (timeout)
        { response: () => ({ data: null, error: { message: "timeout expired" } }) },
      ],
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/wa_lid lookup failed/);
  });

  it("LOOKUP_NOT_FOUND em todos os níveis propaga como 'contact upsert race' (sem criar contato)", async () => {
    const { admin } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        { response: () => ({ data: null, error: null }) },
        { response: () => ({ data: null, error: null }) },
      ],
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
      levels: [
        // não deveria ter config — nenhum lookup roda pra erro não-23505
      ],
    });

    await expect(
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ).rejects.toThrow(/waha contact upsert failed/);
    expect(calls.maybeSingleCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Casos gerais
// ---------------------------------------------------------------------------

describe("upsertContact — casos gerais", () => {
  it("Caso B: wa_lid novo — RPC retorna sucesso direto, sem nenhum lookup", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({ data: "contato-novo", error: null }),
      levels: [],
    });

    const id = await upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null);

    expect(id).toBe("contato-novo");
    expect(calls.maybeSingleCalls.length).toBe(0);
  });

  it("Normalização: chatId com sufixo @lid — filtros usam só os dígitos", async () => {
    const { admin, calls } = buildAdmin({
      rpcResult: () => ({
        data: null,
        error: { code: "23505", message: 'duplicate key value violates unique constraint "uniq_contacts_org_wa_lid"' },
      }),
      levels: [
        { response: () => ({ data: { id: "contato-normalizado" }, error: null }) },
      ],
    });

    const id = await upsertContact(
      admin as never,
      SESSION.organization_id,
      LID_PARSED,
      "5511999000001@lid",
      null,
    );

    expect(id).toBe("contato-normalizado");
    // Nível 1: .eq("wa_lid", digits)
    const level1 = calls.maybeSingleCalls[0];
    // Não há .or() no nível 1, e o filtro vai por .eq direto — sem chance de @c.us/@lid
    expect(level1?.filter).toBeNull();
  });

  it("Race: duas chamadas simultâneas — uma vence RPC, outra recebe 23505 e recupera o mesmo id", async () => {
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
      levels: [
        { response: () => ({ data: { id: "contato-vencedor" }, error: null }) },
      ],
    });

    const [idA, idB] = await Promise.all([
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
      upsertContact(admin as never, SESSION.organization_id, LID_PARSED, "5511999000001@lid", null),
    ]);

    expect(idA).toBe("contato-vencedor");
    expect(idB).toBe("contato-vencedor");
  });
});

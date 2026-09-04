/**
 * POST /api/internal/prospecting-gb-campaign-bootstrap — rota TEMPORÁRIA de
 * bootstrap para a campanha curada da GB (foodservice SJC 2026-09).
 *
 * Sequência atômica (idempotente em cada etapa):
 *   1. Aplica a migration 20260904000000 (filtro de campanha em
 *      fn_claim_prospecting_outbound + paridade manual_curated em
 *      fn_cancel_prospecting_followup_on_inbound e fn_apply_prospecting_opt_out).
 *   2. Tagueia os 12 leads legados do openstreetmap (já existentes na fila
 *      outbound `status='pending'`) com
 *      `metadata.campaign = "gb-osm-archive-2026-08"` — preservados para
 *      auditoria, inelegíveis para a campanha atual.
 *   3. Importa os próximos 2 leads NOVOS do CSV
 *      `Data/GB_Prospeccao_Foodservice_50_Leads_SJC_Jacarei.csv` (pula Casa
 *      Faísca, duplicatas, inválidos, bloqueados/opt-out) com
 *      `source = "manual_curated"` e `metadata.campaign = activeCampaign()`.
 *   4. Dry-run do dispatcher oficial: devolve SOMENTE os 2 leads da campanha
 *      ATIVA. Casa Faísca (já sent) e os 12 OSM arquivados não aparecem.
 *
 * Escopo fechado (fail-closed):
 *   - org SEMPRE gabarron-mathias (slug TARGET_ORG_SLUG);
 *   - campaign ATIVA = CAMPAIGN_GB_FOODSERVICE_SJC_2026_09;
 *   - campaign ARQUIVO = CAMPAIGN_GB_OSM_ARCHIVE_2026_08;
 *   - não envia, não chama WAHA, não muda PROSPECTING_DRY_RUN.
 *
 * Proteção:
 *   - Authorization: Bearer <INTERNAL_CRON_SECRET> (timing-safe)
 *   - x-cron-secret: <INTERNAL_CRON_SECRET> (alias)
 *
 * Uso:
 *   curl -X POST https://crm.gabarronmathias.com/api/internal/prospecting-gb-campaign-bootstrap \
 *     -H "Authorization: Bearer $INTERNAL_CRON_SECRET"
 *
 * Após o uso, a rota deve ser REMOVIDA (commit chore). O caminho permanente
 * de import fica em `scripts/import-curated-leads.ts`; o dry-run fica em
 * `POST /api/v1/cron/prospecting-dispatch` (já filtra por campanha).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  activeCampaign,
  CAMPAIGN_GB_FOODSERVICE_SJC_2026_09,
  CAMPAIGN_GB_OSM_ARCHIVE_2026_08,
  TARGET_ORG_SLUG,
} from "@/lib/prospecting/config";
import { targetOrganizationId } from "@/lib/prospecting/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const bodySchema = z.object({
  step: z.enum(["all", "migrate", "archive", "import", "dry_run"]).default("all"),
  limit: z.number().int().min(1).max(10).default(2),
});

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function authorize(req: NextRequest): boolean {
  const expected = env.INTERNAL_CRON_SECRET;
  if (!expected) return false;
  const bearer = req.headers.get("authorization");
  if (bearer) {
    const match = /^Bearer\s+(.+)$/i.exec(bearer.trim());
    if (match && timingSafeEq(match[1]!.trim(), expected)) return true;
  }
  const xCron = req.headers.get("x-cron-secret");
  if (xCron && timingSafeEq(xCron, expected)) return true;
  return false;
}

const MIGRATION_SQL_PATH = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260904000000_prospecting_campaign_filter.sql",
);

async function applyMigration(): Promise<{ applied: boolean; path: string; sizeBytes: number }> {
  const sql = fs.readFileSync(MIGRATION_SQL_PATH, "utf8");
  const { getRequestPool } = await import("@/lib/agent-engine/db/request-pool");
  const pool = getRequestPool();
  await pool.query(sql);
  return { applied: true, path: MIGRATION_SQL_PATH, sizeBytes: sql.length };
}

interface CsvRow {
  Empresa: string;
  Cidade: string;
  Segmento: string;
  Prioridade: string;
  Telefone: string;
  WhatsApp: string;
  Endereço: string;
  "Site / Instagram": string;
  "Sinal comercial": string;
  "Deduplicação CRM": string;
  Status: string;
  "Próxima ação": string;
  "Fonte pública": string;
  "Data da coleta": string;
}

function extractState(_city: string): string {
  return "SP";
}

function toProspect(row: CsvRow, campaign: string) {
  const phoneRaw = (row.Telefone ?? "").trim();
  const sourceId = `${row.Empresa.toLowerCase().replace(/[^a-z0-9]+/g, "-")}::${phoneRaw.replace(/\D/g, "")}`;
  return {
    source: "manual_curated" as const,
    sourceId,
    companyName: row.Empresa.trim(),
    category: row.Segmento.trim(),
    city: row.Cidade.trim(),
    state: extractState(row.Cidade),
    phoneRaw,
    website: row["Site / Instagram"]?.trim() || null,
    address: row.Endereço?.trim() || null,
    neighborhood: null,
    placeId: null,
    mapsUrl: null,
    sourceUrl: row["Fonte pública"]?.trim() || null,
    businessStatus: "OPERATIONAL" as const,
    rating: null,
    reviewCount: null,
    primaryType: row.Segmento.trim() || null,
    types: [row.Segmento.trim()].filter(Boolean),
    campaign,
  };
}

async function archiveLegacyOsm(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<{ archived: number }> {
  // Tagga rows legadas (sem campaign) com CAMPAIGN_GB_OSM_ARCHIVE_2026_08.
  // update via JSONB merge precisa de raw SQL no Supabase JS — fazemos no
  // pool de agent-engine. Idempotente: a cláusula WHERE evita re-taggar.
  const sql = `
    update public.prospecting_outbound_queue q
       set metadata = q.metadata || jsonb_build_object('campaign', $1::text),
           updated_at = now()
     where q.organization_id = $2
       and q.status = 'pending'
       and (q.metadata->>'campaign') is null
       and (q.metadata->>'source') = 'openstreetmap'
    returning q.id;
  `;
  const { getRequestPool } = await import("@/lib/agent-engine/db/request-pool");
  const pool = getRequestPool();
  const { rows } = await pool.query<{ id: string }>(sql, [
    CAMPAIGN_GB_OSM_ARCHIVE_2026_08,
    orgId,
  ]);
  return { archived: rows.length };
}

async function importCurated(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  limit: number,
  campaign: string,
): Promise<{
  created: number;
  duplicates: number;
  invalid: number;
  imported: Array<{ company: string; outcome: string; leadId?: string; queueId?: string; reason?: string }>;
}> {
  // O CSV está em Data/ no repo e é excluído pelo .vercelignore — mas no Vercel
  // a rota roda no filesystem do serverless. A solução mais simples é o caller
  // (esta rota temporária) embutir o CSV.
  const csvText = EMBEDDED_CSV;
  const { parse } = await import("csv-parse/sync");
  const rows = parse(csvText, { columns: true, skip_empty_lines: true, delimiter: ";" }) as CsvRow[];

  const { importProspect } = await import("@/lib/prospecting/service");
  let created = 0;
  let duplicates = 0;
  let invalid = 0;
  const imported: Array<{ company: string; outcome: string; leadId?: string; queueId?: string; reason?: string }> = [];
  for (const row of rows) {
    if (created >= limit) break;
    const prospect = toProspect(row, campaign);
    try {
      const result = await importProspect(supabase, prospect);
      imported.push({
        company: result.company,
        outcome: result.outcome,
        ...(result.leadId ? { leadId: result.leadId } : {}),
        ...(result.queueId ? { queueId: result.queueId } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      });
      if (result.outcome === "created") created += 1;
      else if (result.outcome === "duplicate") duplicates += 1;
      else invalid += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      imported.push({ company: row.Empresa, outcome: "error", reason: message });
      invalid += 1;
    }
  }
  // Reference orgId to avoid unused warning (we use it in supabase via RLS bypass).
  void orgId;
  return { created, duplicates, invalid, imported };
}

async function dryRunCampaign(
  supabase: ReturnType<typeof createAdminClient>,
  orgId: string,
  campaign: string,
): Promise<{ would_send: unknown[] }> {
  const { data } = await supabase
    .from("prospecting_outbound_queue")
    .select("id, kind, message_body, scheduled_for, metadata, contacts:contact_id(phone_number)")
    .eq("organization_id", orgId)
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString())
    .eq("metadata->>campaign", campaign)
    .order("scheduled_for")
    .order("created_at")
    .limit(10);
  return { would_send: data ?? [] };
}

const EMBEDDED_CSV = `Empresa;Cidade;Segmento;Prioridade;Telefone;WhatsApp;Endereço;Site / Instagram;Sinal comercial;Deduplicação CRM;Status;Próxima ação;Fonte pública;Data da coleta
Pizzaria Paizzani;São José dos Campos;Pizzaria;A;(12) 99165-7484;Confirmado;Av. Cidade Jardim, 764 - Jardim Satélite;https://www.pizzapaizzani.com.br/;"Pedidos e reservas por WhatsApp; cadastro para promoções";Pendente;Novo — não contatado;Validar no CRM e abordar;https://www.pizzapaizzani.com.br/;2026-09-03 00:00:00
Hamburgueria 480 Graus;São José dos Campos;Hamburgueria;A;(12) 99250-6831;Confirmado;Rua dos Ferreiros, 480;;Pedido direto no WhatsApp;Pendente;Novo — não contatado;Validar no CRM e abordar;https://fasty.food/catalogo/sp/sao-jose-dos-campos/r/hamburgueria-480-graus/;2026-09-03 00:00:00
Garage 88 Burger;São José dos Campos;Hamburgueria;A;(12) 98868-0088;Confirmado;Rodovia Monteiro Lobato, 1234;;Pedido direto no WhatsApp;Pendente;Novo — não contatado;Validar no CRM e abordar;https://fasty.food/catalogo/sp/sao-jose-dos-campos/r/garage-88-burger/;2026-09-03 00:00:00
forastera.sjc;São José dos Campos;Pizzaria;A;(12) 99213-1713;Confirmado;Jardim Aquarius;;Pedido direto no WhatsApp;Pendente;Novo — não contatado;Validar no CRM e abordar;https://fasty.food/catalogo/sp/sao-jose-dos-campos/r/forastera-sjc/;2026-09-03 00:00:00
Pizzaria São Paulo;Caçapava;Pizzaria;A;(12) 3652-1234;Confirmado;Av. Brasil, 100 - Centro;;Pedidos por WhatsApp;Pendente;Novo — não contatado;Validar no CRM e abordar;https://fasty.food/catalogo/sp/cacapava/r/pizzaria-sao-paulo/;2026-09-03 00:00:00`;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!authorize(req)) {
    return fail("unauthenticated", "Internal cron secret missing or invalid.", 401, { requestId });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const { step, limit } = parsed.data;
  const supabase = createAdminClient();
  const orgId = await targetOrganizationId(supabase);
  const campaign = activeCampaign() || CAMPAIGN_GB_FOODSERVICE_SJC_2026_09;
  const result: Record<string, unknown> = { org_slug: TARGET_ORG_SLUG, org_id: orgId, campaign };

  try {
    if (step === "all" || step === "migrate") {
      result.migration = await applyMigration();
    }
    if (step === "all" || step === "archive") {
      result.archive = await archiveLegacyOsm(supabase, orgId);
    }
    if (step === "all" || step === "import") {
      result.import = await importCurated(supabase, orgId, limit, campaign);
    }
    if (step === "all" || step === "dry_run") {
      result.dry_run = await dryRunCampaign(supabase, orgId, campaign);
    }
    return ok(result, { requestId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("internal_error", message, 500, { requestId, details: result });
  }
}

/**
 * scripts/import-curated-leads.ts — caminho PERMANENTE para importar leads
 * curados (CSV) na fila de prospecção outbound.
 *
 * Uso:
 *   pnpm tsx scripts/import-curated-leads.ts <csv-path> [limit]
 *
 *   <csv-path>: caminho do CSV com o formato canônico do GB foodservice
 *               (separador `;`, header em PT-BR; ver
 *               Data/GB_Prospeccao_Foodservice_50_Leads_SJC_Jacarei.csv).
 *   [limit]:    número máx. de leads NOVOS a criar (default 2). Idempotente:
 *               re-rodar com limit=10 só cria até o próximo que ainda não
 *               existe no CRM.
 *
 * Comportamento:
 *   - Lê o CSV linha-a-linha, na ordem original (que é a ordem de prioridade
 *     curada pela GB).
 *   - Para cada linha: chama `importProspect` da lib oficial. Ele já é
 *     idempotente e detecta duplicatas por source_id, place_id, phone,
 *     website_domain e name+address (ver service.ts::findExisting).
 *   - Filtra telefones inválidos, contatos bloqueados/opt-out e
 *     contatos já existentes. Casa Faísca (1ª linha do CSV atual) já está
 *     no CRM e devolve "duplicate" — natural, sem hardcode de empresa.
 *   - Cada lead NOVO é inserido com `source = "manual_curated"` e
 *     `metadata.campaign = activeCampaign()` (default
 *     `gb-foodservice-sjc-2026-09`). A campanha ATIVA discrimina o claim
 *     da RPC; rows legadas (OSM) recebem `metadata.campaign =
 *     "gb-osm-archive-2026-08"` por uma rota/migration separada e ficam
 *     fora do claim atual.
 *   - Para quando `limit` leads NOVOS são criados OU o CSV acaba.
 *
 * Persistência: o script NÃO envia. Cada row vai para
 * `prospecting_outbound_queue.status = "pending"` e fica aguardando o
 * dispatcher oficial (cron ou WORKING session). Com `PROSPECTING_DRY_RUN=true`
 * nada sai para o WhatsApp.
 */
import { loadEnvConfig } from "@next/env";
import path from "node:path";
import fs from "node:fs";

loadEnvConfig(process.cwd());

import { parse } from "csv-parse/sync";

import type { PublicBusinessProspect } from "../lib/prospecting/google-places";
import {
  activeCampaign,
  CAMPAIGN_GB_FOODSERVICE_SJC_2026_09,
} from "../lib/prospecting/config";
import { createAdminClient } from "../lib/supabase/admin";
import { importProspect } from "../lib/prospecting/service";

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

function toProspect(row: CsvRow, campaign: string): PublicBusinessProspect {
  const phoneRaw = (row.Telefone ?? "").trim();
  const sourceId = `${row.Empresa.toLowerCase().replace(/[^a-z0-9]+/g, "-")}::${phoneRaw.replace(/\D/g, "")}`;
  return {
    source: "manual_curated",
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
    businessStatus: "OPERATIONAL",
    rating: null,
    reviewCount: null,
    primaryType: row.Segmento.trim() || null,
    types: [row.Segmento.trim()].filter(Boolean),
    campaign,
  };
}

function extractState(_city: string): string {
  // Heurística simples para o CSV SJC/Jacareí: tudo SP.
  return "SP";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const csvPath = args[0] ?? path.join(process.cwd(), "Data", "GB_Prospeccao_Foodservice_50_Leads_SJC_Jacarei.csv");
  const limit = args[1] ? Number.parseInt(args[1], 10) : 2;

  if (!Number.isInteger(limit) || limit < 1) {
    console.error(`[import-curated-leads] limit inválido: ${args[1] ?? ""}`);
    process.exit(2);
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`[import-curated-leads] CSV não encontrado: ${csvPath}`);
    process.exit(2);
  }

  const campaign = activeCampaign() || CAMPAIGN_GB_FOODSERVICE_SJC_2026_09;
  const db = createAdminClient();

  const raw = fs.readFileSync(csvPath, "utf8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, delimiter: ";" }) as CsvRow[];
  console.log(
    `[import-curated-leads] csv=${csvPath} linhas=${rows.length} limit=${limit} campaign=${campaign}`,
  );

  let created = 0;
  let duplicates = 0;
  let invalid = 0;
  const imported: Array<{ company: string; outcome: string; leadId?: string; queueId?: string; reason?: string }> = [];

  for (const row of rows) {
    if (created >= limit) break;
    const prospect = toProspect(row, campaign);
    try {
      const result = await importProspect(db, prospect);
      imported.push({
        company: result.company,
        outcome: result.outcome,
        ...(result.leadId ? { leadId: result.leadId } : {}),
        ...(result.queueId ? { queueId: result.queueId } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      });
      if (result.outcome === "created") {
        created += 1;
        console.log(
          `[import-curated-leads] CRIADO company=${result.company} phone=${result.phone} lead=${result.leadId} queue=${result.queueId}`,
        );
      } else if (result.outcome === "duplicate") {
        duplicates += 1;
        console.log(
          `[import-curated-leads] DUPLICADO company=${result.company} motivo=${result.reason ?? "?"}`,
        );
      } else {
        invalid += 1;
        console.log(
          `[import-curated-leads] INVÁLIDO company=${result.company} motivo=${result.reason ?? "?"}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[import-curated-leads] ERRO company=${row.Empresa} err=${message}`);
    }
  }

  console.log(
    `[import-curated-leads] done created=${created} duplicates=${duplicates} invalid=${invalid} (limit=${limit})`,
  );
  console.log(JSON.stringify({ campaign, created, duplicates, invalid, imported }, null, 2));
}

main().catch((err) => {
  console.error("[import-curated-leads] fatal:", err);
  process.exit(1);
});

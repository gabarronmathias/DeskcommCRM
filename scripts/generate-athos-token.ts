/**
 * Gera um API token server-to-server com scope `orders:read` para o time Athos.
 *
 * Contexto (EPIC-21): a Sarah e o time Athos consomem `GET /api/v1/customers/
 * [phone]/order-history` para ver o histórico de compras de um cliente e
 * gerar campanhas de recompra / reativação. Esta API é autenticada via
 * Bearer `dsk_...` (api_tokens) e exige o scope granular `orders:read`.
 *
 * Este script é o ÚNICO ponto de geração de tokens pra Athos: ele produz o
 * plaintext UMA vez (a tabela guarda SHA256 — reverter não dá), com escopo
 * fixo e prazo de validade. Quem rodar precisa ser o admin da plataforma
 * (ter service-role).
 *
 * Uso (env vars do .env / .env.local — o script NÃO chama `lib/env.ts` para
 * aceitar setup local sem o env completo do app):
 *
 *   ORG_SLUG=gabarron-mathias \
 *   TOKEN_NAME="Athos order-history" \
 *   EXPIRES_IN_DAYS=365 \
 *   npx tsx scripts/generate-athos-token.ts
 *
 * Output (plaintext mostrado UMA VEZ, mesmo padrão de
 * `POST /api/v1/settings/api-tokens`):
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ ⚠️  Salve este token agora — ele não será mostrado de novo.       │
 *   │ Bearer dsk_aabbccdd_<32-byte-random-base64url>                    │
 *   │ expires_at: 2027-09-11                                            │
 *   │ scopes: ["orders:read"]                                           │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Idempotente? NÃO — cada execução gera um token novo. Pra revogar um
 * anterior, `POST /api/v1/settings/api-tokens/[id]/revoke` (ou direto no
 * banco: `update api_tokens set revoked_at = now() where id = '...'`).
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const file of [".env", ".env.local"]) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !out[m[1]!]) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
    }
  }
  return out;
}

const env = loadEnv();

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
const ORG_SLUG = env.ORG_SLUG;
const TOKEN_NAME = env.TOKEN_NAME ?? "Athos order-history";
const EXPIRES_IN_DAYS = env.EXPIRES_IN_DAYS ? Number(env.EXPIRES_IN_DAYS) : 365;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error(
    "Faltam NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Configure no .env.local ou passe via env.",
  );
  process.exit(1);
}
if (!ORG_SLUG) {
  console.error("Falta ORG_SLUG (slug da organização dona do token, ex.: gabarron-mathias).");
  process.exit(1);
}
if (!Number.isFinite(EXPIRES_IN_DAYS) || EXPIRES_IN_DAYS < 1 || EXPIRES_IN_DAYS > 3650) {
  console.error("EXPIRES_IN_DAYS precisa ser entre 1 e 3650.");
  process.exit(1);
}

async function main(): Promise<void> {
  // Admin client (service-role) — atravessa RLS. Service-role bypass é
  // proposital aqui: o script é o ÚNICO caminho de mintar tokens sem passar
  // pela UI.
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Resolve a org pelo slug.
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("id, slug, display_name")
    .eq("slug", ORG_SLUG)
    .maybeSingle();
  if (orgErr) {
    console.error("Falha ao buscar org:", orgErr.message);
    process.exit(1);
  }
  if (!org) {
    console.error(`Org com slug '${ORG_SLUG}' não encontrada.`);
    process.exit(1);
  }

  // 2. Gera o token (mesmo formato de POST /api/v1/settings/api-tokens:
  //    `dsk_<8-hex-prefix>_<32-byte-random-base64url>`).
  const prefix = `dsk_${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${prefix}_${secret}`;
  const tokenHash = createHash("sha256").update(plaintext).digest();

  // 3. Define um `created_by` razoável — qualquer platform_admin serve. Se a
  //    org não tiver um, criamos SEM created_by (a coluna é nullable).
  const { data: admin } = await supabase
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", org.id)
    .eq("role", "admin")
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();

  // 4. Insere. `token_hash` é bytea: o PostgREST espera literal `\x<hex>`.
  const expiresAt = new Date(Date.now() + EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: created, error: insErr } = await supabase
    .from("api_tokens")
    .insert({
      organization_id: org.id,
      created_by: admin?.user_id ?? null,
      name: TOKEN_NAME,
      prefix,
      token_hash: `\\x${tokenHash.toString("hex")}`,
      scopes: ["orders:read"],
      expires_at: expiresAt,
    })
    .select("id, prefix, scopes, expires_at, created_at")
    .single();

  if (insErr || !created) {
    console.error("Falha ao inserir token:", insErr?.message ?? "sem retorno");
    process.exit(1);
  }

  // 5. Output pro operador. PLAINTEXT APARECE UMA VEZ — depois disso só o
  //    hash SHA256 fica na tabela. Mesmo padrão de UI.
  const box = [
    "┌─────────────────────────────────────────────────────────────────┐",
    "│ ⚠️  Salve este token agora — ele não será mostrado de novo.       │",
    `│ Bearer ${plaintext.padEnd(51)}│`,
    `│ prefix:    ${created.prefix.padEnd(53)}│`,
    `│ scopes:    ${JSON.stringify(created.scopes).padEnd(53)}│`,
    `│ org:       ${org.slug} (${org.id})${"".padEnd(Math.max(0, 53 - org.slug.length - org.id.length - 6))}│`,
    `│ expires_at: ${created.expires_at.padEnd(51)}│`,
    `│ token_id:  ${created.id.padEnd(53)}│`,
    "└─────────────────────────────────────────────────────────────────┘",
  ].join("\n");
  console.log(box);

  console.log("\nPróximos passos:");
  console.log(
    `  1. Revogue o token ao final do contrato: POST /api/v1/settings/api-tokens/${created.id}/revoke`,
  );
  console.log(
    "  2. Doc do contrato pra mandar pro Athos: docs/integracoes/athos-order-history.md",
  );
  console.log("  3. Exemplo de curl pronto: examples/athos-curl.sh");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

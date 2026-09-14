/**
 * Seed E2E test credentials: 1 org + 4 users (admin, manager, agent, viewer) + 1 ai_agents default.
 * Idempotent: re-runs upsert by email/org name. Também garante um factor TOTP
 * verified no admin com secret CONHECIDO (gravado em .e2e-creds.json) para o
 * Playwright passar o challenge MFA — MFA do admin nunca é desabilitado.
 *
 * Output: .e2e-creds.json (gitignored) com URLs e creds para Playwright/curl.
 *
 * Run: npx tsx scripts/seed-e2e-credentials.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

import { generateTotp } from "../tests/e2e/utils/totp";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

// `process.env` VENCE o `.env.local` (ver scripts/lib/env-de-teste.ts).
//
// A versão anterior lia `.env.local` DIRETO do disco, e por isso a suíte E2E
// semeava org, usuários e agentes no banco de PRODUÇÃO: o `.env.e2e` injetado no
// webServer do Playwright nunca alcançava este script, porque ele não olhava
// para o ambiente. Medido em 2026-08-06 — o factor TOTP em `.e2e-creds.json` não
// existia no banco local porque tinha sido criado na nuvem.
const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-credentials", credenciais);
const SUPABASE_URL = credenciais.url;
const SERVICE_ROLE = credenciais.serviceRole;
const ANON_KEY = credenciais.anonKey;
const APP_URL = credenciais.appUrl;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG_NAME = "E2E Test Org";
const ORG_SLUG = "e2e-test-org";
const PASSWORD = "E2E!Test1234";

const USERS: Array<{
  email: string;
  role: "admin" | "manager" | "agent" | "viewer";
  full_name: string;
}> = [
  { email: "e2e-admin@gabarronmathias.test", role: "admin", full_name: "E2E Admin" },
  { email: "e2e-manager@gabarronmathias.test", role: "manager", full_name: "E2E Manager" },
  { email: "e2e-agent@gabarronmathias.test", role: "agent", full_name: "E2E Agent" },
  { email: "e2e-viewer@gabarronmathias.test", role: "viewer", full_name: "E2E Viewer" },
];

async function ensureOrg(): Promise<string> {
  const { data: existing } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", ORG_SLUG)
    .maybeSingle();
  if (existing) {
    console.log(`[seed] org existing: ${(existing as { id: string }).id}`);
    return (existing as { id: string }).id;
  }
  const { data, error } = await admin
    .from("organizations")
    .insert({
      slug: ORG_SLUG,
      display_name: ORG_NAME,
      legal_name: ORG_NAME,
      timezone: "America/Sao_Paulo",
      locale: "pt-BR",
      onboarded_at: new Date().toISOString(),
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error("create org: " + error?.message);
  const orgId = (data as { id: string }).id;
  console.log(`[seed] org created: ${orgId}`);
  return orgId;
}

async function ensureUser(email: string, full_name: string): Promise<string> {
  // listUsers paginado — perPage default 50; nosso pool é pequeno
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const existing = list.users.find((u) => u.email === email);
  if (existing) {
    console.log(`[seed] user existing ${email}: ${existing.id}`);
    // garantir senha conhecida
    await admin.auth.admin.updateUserById(existing.id, { password: PASSWORD });
    return existing.id;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name },
  });
  if (error || !data?.user) throw new Error(`create user ${email}: ${error?.message}`);
  console.log(`[seed] user created ${email}: ${data.user.id}`);
  return data.user.id;
}

async function ensureMembership(userId: string, orgId: string, role: string): Promise<void> {
  const { data: existing } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (existing) {
    await admin
      .from("user_organizations")
      .update({ role, revoked_at: null } as never)
      .eq("user_id", userId)
      .eq("organization_id", orgId);
    console.log(`[seed] membership updated user=${userId} role=${role}`);
    return;
  }
  const { error } = await admin.from("user_organizations").insert({
    user_id: userId,
    organization_id: orgId,
    role,
    accepted_at: new Date().toISOString(),
  } as never);
  if (error) throw new Error(`membership insert: ${error.message}`);
  console.log(`[seed] membership inserted user=${userId} role=${role}`);
}

async function ensureAgent(orgId: string): Promise<string> {
  const { data: existing } = await admin
    .from("ai_agents")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  if (existing) {
    console.log(`[seed] ai_agent default existing: ${(existing as { id: string }).id}`);
    return (existing as { id: string }).id;
  }
  const { data, error } = await admin
    .from("ai_agents")
    .insert({
      organization_id: orgId,
      name: "Bot Padrão E2E",
      description: "Agent default para testes E2E",
      is_active: true,
      is_default: true,
      model: "anthropic/claude-sonnet-4-6",
      system_prompt:
        "Você é um assistente do CRM E2E. Responda de forma educada e use os {rag_chunks} disponíveis.",
      config: {
        temperature: 0.4,
        max_tokens: 1024,
        context_message_window: 20,
        rag_top_k: 5,
        rag_similarity_threshold: 0.72,
        confidence_threshold: 0.6,
      },
      guardrails: [],
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error("ai_agent insert: " + error?.message);
  const id = (data as { id: string }).id;
  console.log(`[seed] ai_agent default created: ${id}`);
  return id;
}

interface AdminTotp {
  factor_id: string;
  secret: string;
}

/**
 * Garante um factor TOTP verified com secret conhecido no admin (MFA é
 * mandatório pra role admin; o e2e precisa do secret pra responder o challenge).
 * Idempotente: reutiliza o factor gravado em .e2e-creds.json se ele ainda
 * existir verified; senão rotaciona (delete + enroll + verify). O admin nunca
 * fica sem MFA no estado final.
 */
async function ensureAdminTotp(adminUserId: string, adminEmail: string): Promise<AdminTotp> {
  let prev: AdminTotp | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(".e2e-creds.json", "utf8")) as {
      admin_totp?: AdminTotp;
    };
    if (raw.admin_totp?.factor_id && raw.admin_totp.secret) prev = raw.admin_totp;
  } catch {
    prev = null; // sem creds anteriores — enroll do zero
  }

  const { data: listed, error: listErr } = await admin.auth.admin.mfa.listFactors({
    userId: adminUserId,
  });
  if (listErr) throw new Error("listFactors: " + listErr.message);
  const factors = listed?.factors ?? [];

  if (prev && factors.some((f) => f.id === prev!.factor_id && f.status === "verified")) {
    console.log(`[seed] admin TOTP factor reused: ${prev.factor_id}`);
    return prev;
  }

  // Rotaciona: remove factors TOTP existentes (secret desconhecido) e re-enrolla.
  for (const f of factors) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: adminUserId });
    if (error) throw new Error(`deleteFactor ${f.id}: ${error.message}`);
    console.log(`[seed] admin TOTP factor removed (rotating): ${f.id}`);
  }

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInErr } = await anon.auth.signInWithPassword({
    email: adminEmail,
    password: PASSWORD,
  });
  if (signInErr) throw new Error("admin signIn for TOTP enroll: " + signInErr.message);

  const { data: enrolled, error: enrollErr } = await anon.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "e2e-seed",
  });
  if (enrollErr || !enrolled) throw new Error("mfa.enroll: " + enrollErr?.message);
  const secret = enrolled.totp.secret;

  const { data: challenge, error: chErr } = await anon.auth.mfa.challenge({
    factorId: enrolled.id,
  });
  if (chErr || !challenge) throw new Error("mfa.challenge: " + chErr?.message);

  const { error: verifyErr } = await anon.auth.mfa.verify({
    factorId: enrolled.id,
    challengeId: challenge.id,
    code: generateTotp(secret),
  });
  if (verifyErr) throw new Error("mfa.verify: " + verifyErr.message);
  await anon.auth.signOut();

  console.log(`[seed] admin TOTP factor enrolled: ${enrolled.id}`);
  return { factor_id: enrolled.id, secret };
}

async function main(): Promise<void> {
  const orgId = await ensureOrg();

  const users: Record<string, { id: string; email: string; role: string }> = {};
  for (const u of USERS) {
    const userId = await ensureUser(u.email, u.full_name);
    await ensureMembership(userId, orgId, u.role);
    users[u.role] = { id: userId, email: u.email, role: u.role };
  }

  const agentId = await ensureAgent(orgId);
  const adminTotp = await ensureAdminTotp(users.admin!.id, users.admin!.email);

  const creds = {
    org_id: orgId,
    org_slug: ORG_SLUG,
    org_name: ORG_NAME,
    password: PASSWORD,
    users,
    admin_totp: adminTotp,
    default_agent_id: agentId,
    app_url: APP_URL,
    supabase_url: SUPABASE_URL,
    supabase_anon_key: ANON_KEY,
  };

  fs.writeFileSync(".e2e-creds.json", JSON.stringify(creds, null, 2));
  console.log("\n✅ Seed completo. Credenciais escritas em .e2e-creds.json");
  console.log(`org: ${orgId}`);
  console.log(`agent default: ${agentId}`);
  console.log(`users: ${Object.values(users).map((u) => `${u.role}=${u.email}`).join(", ")}`);
}

main().catch((err) => {
  console.error("❌ Seed falhou:", err);
  process.exit(1);
});

"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicarMemoriaDaOrg } from "@/lib/ai/memoria-da-org";
import {
  companyProfileSchema,
  operationSchema,
  sarahSettingsSchema,
  operatorSettingsSchema,
  catalogProductSchema,
  newCatalogCategorySchema,
  newCatalogProductSchema,
  onboardingStepSchema,
} from "@/lib/admin-onboarding/schema";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

async function orgState(organizationId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("organizations")
    .select("id,display_name,settings,onboarding_state,onboarded_at")
    .eq("id", organizationId).maybeSingle();
  if (error || !data) throw new Error("Empresa não encontrada.");
  return { admin, org: data, settings: record(data.settings), state: record(data.onboarding_state) };
}

async function saveSetup(
  organizationId: string,
  patch: JsonRecord,
  settingsPatch?: JsonRecord,
) {
  const { admin, settings, state } = await orgState(organizationId);
  const oldSetup = record(state.foodservice_setup);
  const completed = new Set(Array.isArray(oldSetup.completed_steps)
    ? oldSetup.completed_steps.filter((s): s is string => typeof s === "string")
    : []);
  const step = patch.step;
  if (typeof step === "string") completed.add(step);
  const nextState = {
    ...state,
    foodservice_setup: {
      ...oldSetup,
      ...patch,
      completed_steps: [...completed],
      updated_at: new Date().toISOString(),
    },
  };
  const nextSettings = settingsPatch
    ? { ...settings, foodservice: { ...record(settings.foodservice), ...settingsPatch } }
    : settings;
  const { error } = await admin.from("organizations")
    .update({ onboarding_state: nextState, settings: nextSettings })
    .eq("id", organizationId);
  if (error) throw new Error("Não foi possível salvar o progresso.");
  revalidatePath(`/admin/tenants/${organizationId}`);
  revalidatePath(`/admin/tenants/${organizationId}/onboarding`);
}

export async function saveCompanyProfile(organizationId: string, input: unknown) {
  const { user } = await requirePlatformAdmin();
  const parsed = companyProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Confira os dados da empresa." };
  await saveSetup(organizationId, { step: "company", company: parsed.data }, { company: parsed.data });
  await audit({ action: "platform_admin.onboarding_company_saved", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId, metadata: { step: "company" } });
  return { ok: true as const };
}

export async function saveOperationSettings(organizationId: string, input: unknown) {
  const { user } = await requirePlatformAdmin();
  const parsed = operationSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Dados da operação inválidos." };
  await saveSetup(organizationId, { step: "operation", operation: parsed.data }, { operation: parsed.data });
  await audit({ action: "platform_admin.onboarding_operation_saved", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId, metadata: { step: "operation" } });
  return { ok: true as const };
}

function sarahMemoryContent(data: ReturnType<typeof sarahSettingsSchema.parse>) {
  const fields = [
    ["Mensagem inicial", data.greeting],
    ["Regras importantes", data.rules],
    ["Orientações comerciais", data.commercial_guidance],
    ["Produtos prioritários", data.priority_products],
    ["Orientação de venda adicional", data.upsell_guidance],
    ["Quando chamar uma pessoa", data.handoff_guidance],
  ] as const;
  return `Nome de atendimento: ${data.name}\n\n${fields
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}:\n${value.trim()}`)
    .join("\n\n")}`;
}

export async function saveSarahDraftSettings(organizationId: string, input: unknown) {
  const { user } = await requirePlatformAdmin();
  const parsed = sarahSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Confira as orientações da Sarah." };
  await saveSetup(organizationId, { step: "sarah", sarah: parsed.data }, { sarah: parsed.data });
  await audit({ action: "platform_admin.onboarding_sarah_saved", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId,
    metadata: { step: "sarah", memory_status: "draft" } });
  return { ok: true as const };
}

export async function publishSarahMemory(organizationId: string, input: unknown) {
  const { user } = await requirePlatformAdmin();
  const parsed = sarahSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Confira as orientações da Sarah." };
  const { admin } = await orgState(organizationId);
  const memory = await publicarMemoriaDaOrg(admin, organizationId, user.id, sarahMemoryContent(parsed.data));
  if (!memory.ok) return { ok: false as const, error: "A Sarah não conseguiu salvar essas orientações na memória da empresa." };
  await saveSetup(organizationId, {
    step: "sarah", sarah: parsed.data, memory_version_id: memory.versionId,
  }, { sarah: parsed.data });
  await audit({ action: "platform_admin.onboarding_sarah_saved", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId, metadata: { memory_version: memory.versionNumber } });
  return { ok: true as const, versionNumber: memory.versionNumber, unchanged: memory.unchanged ?? false };
}

export async function saveOperatorSettings(organizationId: string, input: unknown) {
  const { user } = await requirePlatformAdmin();
  const parsed = operatorSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Confira o nome e o e-mail do operador." };
  await saveSetup(organizationId, { step: "team", operator: parsed.data }, { operator: parsed.data });
  await audit({ action: "platform_admin.onboarding_operator_saved", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId,
    metadata: { role: parsed.data.role, handoff_responsible: parsed.data.handoff_responsible } });
  return { ok: true as const };
}

export async function updateCatalogProduct(organizationId: string, input: unknown) {
  const { user } = await requirePlatformAdmin();
  const parsed = catalogProductSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Produto ou preço inválido." };
  const admin = createAdminClient();
  const { data: product, error: readError } = await admin.from("food_products")
    .select("id,compare_at_price_cents").eq("organization_id", organizationId)
    .eq("id", parsed.data.product_id).maybeSingle();
  if (readError || !product) return { ok: false as const, error: "Produto não encontrado nesta empresa." };
  const compareAt = product.compare_at_price_cents;
  const { error } = await admin.from("food_products").update({
    price_cents: parsed.data.price_cents,
    is_available: parsed.data.is_available,
    compare_at_price_cents: compareAt !== null && compareAt < parsed.data.price_cents ? null : compareAt,
  }).eq("organization_id", organizationId).eq("id", parsed.data.product_id);
  if (error) return { ok: false as const, error: "Não foi possível atualizar o produto." };
  await saveSetup(organizationId, { step: "catalog" });
  await audit({ action: "platform_admin.onboarding_catalog_product_updated", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId, resourceType: "food_product",
    resourceId: parsed.data.product_id, metadata: { availability: parsed.data.is_available } });
  return { ok: true as const };
}

export async function createCatalogCategory(organizationId: string, input: unknown) {
  const { user } = await requirePlatformAdmin();
  const parsed = newCatalogCategorySchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Nome da categoria inválido." };
  const admin = createAdminClient();
  const slug = slugify(parsed.data.name);
  const { data: last } = await admin.from("food_categories").select("sort_order")
    .eq("organization_id", organizationId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const { error } = await admin.from("food_categories").insert({
    organization_id: organizationId, name: parsed.data.name, slug,
    sort_order: (last?.sort_order ?? 0) + 1, is_active: true,
  });
  if (error) return { ok: false as const, error: error.code === "23505" ? "Já existe uma categoria com esse nome." : "Não foi possível criar a categoria." };
  await saveSetup(organizationId, { step: "catalog" });
  await audit({ action: "platform_admin.onboarding_catalog_category_created", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId, metadata: { category_name: parsed.data.name } });
  return { ok: true as const };
}

export async function createCatalogProduct(organizationId: string, input: unknown) {
  const { user } = await requirePlatformAdmin();
  const parsed = newCatalogProductSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Confira os dados do produto." };
  const admin = createAdminClient();
  const { data: category } = await admin.from("food_categories").select("id")
    .eq("organization_id", organizationId).eq("id", parsed.data.category_id).maybeSingle();
  if (!category) return { ok: false as const, error: "Categoria não encontrada nesta empresa." };
  const { data: last } = await admin.from("food_products").select("sort_order")
    .eq("organization_id", organizationId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const { error } = await admin.from("food_products").insert({
    organization_id: organizationId, category_id: category.id, name: parsed.data.name,
    slug: slugify(parsed.data.name), description: parsed.data.description || null,
    price_cents: parsed.data.price_cents, sort_order: (last?.sort_order ?? 0) + 1, is_available: true,
  });
  if (error) return { ok: false as const, error: error.code === "23505" ? "Já existe um produto com esse nome." : "Não foi possível criar o produto." };
  await saveSetup(organizationId, { step: "catalog" });
  await audit({ action: "platform_admin.onboarding_catalog_product_created", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId, metadata: { product_name: parsed.data.name } });
  return { ok: true as const };
}

export async function goToOnboardingStep(organizationId: string, rawStep: unknown) {
  await requirePlatformAdmin();
  const parsed = onboardingStepSchema.safeParse(rawStep);
  if (!parsed.success) return { ok: false as const, error: "Etapa inválida." };
  await saveSetup(organizationId, { current_step: parsed.data });
  return { ok: true as const };
}

export async function activateFoodservice(organizationId: string) {
  const { user } = await requirePlatformAdmin();
  const admin = createAdminClient();
  const [orgResult, productsResult, agentsResult, memoryResult, teamResult, metaResult] = await Promise.all([
    admin.from("organizations").select("id,display_name,settings,onboarding_state,onboarded_at").eq("id", organizationId).maybeSingle(),
    admin.from("food_products").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("is_available", true),
    admin.from("ai_agents").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).not("published_version_id", "is", null),
    admin.from("org_memory_pointers").select("version_id").eq("organization_id", organizationId).maybeSingle(),
    admin.from("user_organizations").select("user_id", { count: "exact", head: true })
      .eq("organization_id", organizationId).eq("role", "agent").not("accepted_at", "is", null).is("revoked_at", null),
    admin.from("channel_sessions").select("id").eq("organization_id", organizationId).eq("provider", "meta_cloud").eq("status", "WORKING").limit(1),
  ]);
  if (!orgResult.data) return { ok: false as const, error: "Empresa não encontrada." };
  const settings = record(orgResult.data.settings);
  const food = record(settings.foodservice);
  const operation = record(food.operation);
  const sarah = record(food.sarah);
  const operator = record(food.operator);
  const missing = [
    !orgResult.data.onboarding_state || !record(record(orgResult.data.onboarding_state).foodservice_setup).company ? "dados da empresa" : null,
    Object.keys(operation).length === 0 ? "operação" : null,
    (productsResult.count ?? 0) < 1 ? "ao menos um produto disponível" : null,
    (agentsResult.count ?? 0) < 1 ? "agente publicado" : null,
    !memoryResult.data?.version_id || !sarah.name ? "orientações da Sarah" : null,
    (!operator.email || (teamResult.count ?? 0) < 1) ? "operador associado e convite aceito" : null,
    (metaResult.data?.length ?? 0) < 1 ? "WhatsApp Meta conectado" : null,
  ].filter((value): value is string => value !== null);
  if (missing.length) return { ok: false as const, error: `Faltam: ${missing.join(", ")}.` };

  const { error: settingsError } = await admin.from("food_commerce_settings").upsert({
    organization_id: organizationId, app_name: orgResult.data.display_name, is_enabled: true,
    settings: { ...record((await admin.from("food_commerce_settings").select("settings").eq("organization_id", organizationId).maybeSingle()).data?.settings), operations: operation },
  }, { onConflict: "organization_id" });
  if (settingsError) return { ok: false as const, error: "Não foi possível ativar o catálogo." };

  const nextState = { ...record(orgResult.data.onboarding_state), foodservice_setup: {
    ...record(record(orgResult.data.onboarding_state).foodservice_setup),
    status: "ACTIVE", current_step: "checklist", activated_at: new Date().toISOString(),
  } };
  const { error } = await admin.from("organizations").update({ onboarding_state: nextState, onboarded_at: new Date().toISOString() }).eq("id", organizationId);
  if (error) return { ok: false as const, error: "Não foi possível concluir a implantação." };
  await audit({ action: "platform_admin.foodservice_onboarding_activated", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId, metadata: { checklist: "complete" } });
  revalidatePath("/admin/tenants");
  revalidatePath(`/admin/tenants/${organizationId}/onboarding`);
  return { ok: true as const };
}

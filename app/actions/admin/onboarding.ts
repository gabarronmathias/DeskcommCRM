"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { signInviteToken, INVITE_TTL_SECONDS } from "@/lib/auth/invite-token";
import { buildInviteEmail } from "@/lib/email/templates/invite";
import { sendEmail } from "@/lib/email/resend";
import { marcaDaSaida } from "@/lib/branding/saida";
import { hasAcceptedTeamMembership } from "@/lib/admin-onboarding/team-membership";
import { buildPendingInviteLink } from "@/lib/admin-onboarding/team-invite-link";
import { publicarMemoriaDaOrg } from "@/lib/ai/memoria-da-org";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { buildOnboardingChecklist, missingOnboardingRequirements } from "@/lib/admin-onboarding/checklist";
import { buildSarahMemoryContent, isSarahMemoryPublished } from "@/lib/admin-onboarding/sarah-memory";
import { synchronizeDeliveryPolicy } from "@/lib/foodservice/delivery-policy";
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
    .select("id,display_name,settings,onboarding_state,onboarded_at,updated_at")
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
  let nextSettings = settings;
  if (settingsPatch) {
    const currentFoodservice = record(settings.foodservice);
    const nextFoodservice = { ...currentFoodservice, ...settingsPatch };
    if ("operation" in settingsPatch || "sarah" in settingsPatch) {
      const operation = record(nextFoodservice.operation);
      const sarah = record(nextFoodservice.sarah);
      const rules = typeof sarah.rules === "string" ? sarah.rules : "";
      const requestedOperation = record(settingsPatch.operation);
      nextFoodservice.operation = synchronizeDeliveryPolicy(
        operation,
        rules,
        Object.prototype.hasOwnProperty.call(requestedOperation, "delivery_policy")
          ? requestedOperation.delivery_policy
          : undefined,
      );
    }
    nextSettings = { ...settings, foodservice: nextFoodservice };
  }
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
  const memory = await publicarMemoriaDaOrg(admin, organizationId, user.id, buildSarahMemoryContent(parsed.data));
  if (!memory.ok) return { ok: false as const, error: "A Sarah não conseguiu salvar essas orientações na memória da empresa." };
  await saveSetup(organizationId, {
    step: "sarah", sarah: parsed.data, memory_version_id: memory.versionId,
  }, { sarah: parsed.data });
  await audit({ action: "platform_admin.onboarding_sarah_saved", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId, metadata: { memory_version: memory.versionNumber } });
  return { ok: true as const, versionNumber: memory.versionNumber, unchanged: memory.unchanged ?? false };
}

export async function saveOperatorSettings(organizationId: string, input: unknown, nextStep?: unknown) {
  const { user } = await requirePlatformAdmin();
  const parsed = operatorSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Confira o nome e o e-mail do operador." };
  const next = nextStep === undefined ? undefined : onboardingStepSchema.safeParse(nextStep);
  if (next && !next.success) return { ok: false as const, error: "Etapa seguinte inválida." };
  await saveSetup(organizationId, {
    step: "team", operator: parsed.data,
    ...(next?.success ? { current_step: next.data } : {}),
  }, { operator: parsed.data });
  await audit({ action: "platform_admin.onboarding_operator_saved", actorUserId: user.id,
    actingAsPlatformAdmin: true, bypassedRls: true, organizationId,
    metadata: { role: parsed.data.role, handoff_responsible: parsed.data.handoff_responsible } });
  return { ok: true as const };
}

export async function sendOperatorInvite(organizationId: string, resend = false) {
  const { user } = await requirePlatformAdmin();
  const { admin, org, state } = await orgState(organizationId);
  const setup = record(state.foodservice_setup);
  const foodservice = record(record(org.settings).foodservice);
  const operator = operatorSettingsSchema.safeParse(foodservice.operator ?? setup.operator);
  if (!operator.success) return { status: "error" as const, error: "Salve os dados válidos do operador antes de convidar." };

  const email = operator.data.email.trim().toLowerCase();
  const role = operator.data.role;
  const membershipStatus = await hasAcceptedTeamMembership(admin, organizationId, email, role);
  if (membershipStatus === "error") {
    return { status: "error" as const, error: "Não foi possível verificar a equipe desta empresa." };
  }
  if (membershipStatus === "accepted") {
    return { status: "accepted" as const, email };
  }

  const oldInvite = record(setup.team_invite);
  const expiresAt = typeof oldInvite.expires_at === "string" ? Date.parse(oldInvite.expires_at) : 0;
  const pending = expiresAt > Date.now();
  if (pending && !resend) return { status: "pending" as const, email };

  const inviteId = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS;
  const invitation = {
    invite_id: inviteId,
    email,
    role,
    expires_at: new Date(exp * 1000).toISOString(),
    reserved_at: new Date().toISOString(),
  };
  const nextState = {
    ...state,
    foodservice_setup: { ...setup, team_invite: invitation },
  };
  const updatedAt = new Date(Math.max(Date.now(), Date.parse(String(org.updated_at)) + 1)).toISOString();
  const { data: reserved, error: reserveError } = await admin.from("organizations")
    .update({ onboarding_state: nextState, updated_at: updatedAt })
    .eq("id", organizationId).eq("updated_at", org.updated_at)
    .select("id").maybeSingle();
  if (reserveError || !reserved) {
    return { status: "error" as const, error: "A equipe foi atualizada em paralelo. Recarregue a etapa antes de convidar." };
  }

  const token = signInviteToken({ invite_id: inviteId, email, organization_id: organizationId, role, exp, source: "admin_onboarding" });
  const acceptUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/team/accept-invite/${token}`;
  const marca = await marcaDaSaida(organizationId);
  const { subject, html, text } = buildInviteEmail({
    inviterName: user.email ?? "Administrador da plataforma",
    orgName: org.display_name,
    acceptUrl,
    role,
    expiresAt: new Date(exp * 1000),
    marca,
  });
  let emailDispatched = false;
  try {
    const result = await sendEmail({
      to: email,
      subject,
      html,
      text,
      fromName: marca.nome,
      tags: [{ name: "kind", value: "team_invite" }, { name: "org", value: organizationId }],
    });
    emailDispatched = result.ok;
  } catch {
    // A reserva persistida permite reenvio explícito sem criar outro convite.
  }
  await audit({
    action: "member.invited",
    actorUserId: user.id,
    organizationId,
    resourceType: "membership",
    resourceId: inviteId,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    metadata: { email, role, email_dispatched: emailDispatched, source: "admin_onboarding" },
  });
  if (!emailDispatched) return { status: "error" as const, error: "O convite foi registrado, mas o e-mail não pôde ser enviado. Use Reenviar convite após verificar o serviço de e-mail." };
  revalidatePath(`/admin/tenants/${organizationId}/onboarding`);
  return { status: "sent" as const, email };
}

/** Entrega o link pendente somente a Platform Admin, sem salvar o token. */
export async function getPendingOperatorInviteLink(organizationId: string) {
  const { user } = await requirePlatformAdmin();
  const { admin, org, state } = await orgState(organizationId);
  const setup = record(state.foodservice_setup);
  const foodservice = record(record(org.settings).foodservice);
  const operator = operatorSettingsSchema.safeParse(foodservice.operator ?? setup.operator);
  const invite = record(setup.team_invite);
  if (!operator.success || typeof invite.invite_id !== "string"
    || typeof invite.email !== "string" || typeof invite.role !== "string"
    || typeof invite.expires_at !== "string") {
    return { status: "unavailable" as const };
  }

  const email = invite.email.trim().toLowerCase();
  if (email !== operator.data.email.trim().toLowerCase() || invite.role !== operator.data.role) {
    return { status: "unavailable" as const };
  }
  const membership = await hasAcceptedTeamMembership(admin, organizationId, email, operator.data.role);
  if (membership === "error") return { status: "error" as const };
  if (membership === "accepted") return { status: "accepted" as const };

  const url = buildPendingInviteLink({
    inviteId: invite.invite_id,
    email,
    organizationId,
    role: operator.data.role,
    expiresAt: invite.expires_at,
    baseUrl: env.NEXT_PUBLIC_APP_URL,
  });
  if (!url) return { status: "unavailable" as const };

  await audit({
    action: "platform_admin.onboarding_invite_link_requested",
    actorUserId: user.id,
    organizationId,
    resourceType: "membership",
    resourceId: invite.invite_id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    metadata: { role: operator.data.role, delivery: "admin_copy_link" },
  });
  return { status: "ready" as const, url };
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
  const [orgResult, productsResult, agentsResult, memoryResult, metaChannels] = await Promise.all([
    admin.from("organizations").select("id,display_name,settings,onboarding_state,onboarded_at").eq("id", organizationId).maybeSingle(),
    admin.from("food_products").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("is_available", true),
    admin.from("ai_agents").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).not("published_version_id", "is", null),
    admin.from("org_memory_pointers").select("version_id").eq("organization_id", organizationId).maybeSingle(),
    listSelectableChannels(admin, organizationId)
      .then((channels) => channels.filter((channel) => channel.provider === "meta_cloud" && channel.status === "WORKING"))
      .catch(() => []),
  ]);
  if (!orgResult.data) return { ok: false as const, error: "Empresa não encontrada." };
  const settings = record(orgResult.data.settings);
  const food = record(settings.foodservice);
  const setup = record(record(orgResult.data.onboarding_state).foodservice_setup);
  const company = food.company ?? setup.company;
  const operation = food.operation ?? setup.operation;
  const sarah = food.sarah ?? setup.sarah;
  const operationRecord = record(operation);
  const sarahRecord = record(sarah);
  const serviceAreas = Array.isArray(operationRecord.service_areas)
    ? operationRecord.service_areas.filter((area): area is string => typeof area === "string")
    : [];
  const deliverySeed = deliverySettingsFromSarahRules(
    typeof sarahRecord.rules === "string" ? sarahRecord.rules : "",
    serviceAreas,
  );
  const deliveryPolicyRequired = operationRecord.delivery_policy_required === true || deliverySeed !== null;
  const operator = food.operator ?? setup.operator;
  const parsedOperator = operatorSettingsSchema.safeParse(operator);
  const operatorMembership = parsedOperator.success
    ? await hasAcceptedTeamMembership(admin, organizationId, parsedOperator.data.email, parsedOperator.data.role)
    : "missing";
  const publishedVersionId = memoryResult.data?.version_id;
  const memoryVersion = publishedVersionId
    ? await admin.from("org_memory_versions").select("id,content")
      .eq("organization_id", organizationId).eq("id", publishedVersionId).maybeSingle()
    : { data: null, error: null };
  const checklist = buildOnboardingChecklist({
    company: companyProfileSchema.safeParse(company).success,
    operation: operationSchema.safeParse({ ...operationRecord, delivery_policy_required: deliveryPolicyRequired }).success,
    sarah: (agentsResult.count ?? 0) > 0
      && !memoryVersion.error
      && isSarahMemoryPublished(sarah, publishedVersionId, setup.memory_version_id, memoryVersion.data?.content),
    catalog: (productsResult.count ?? 0) > 0,
    operator: parsedOperator.success && operatorMembership === "accepted",
    whatsapp: metaChannels.length > 0,
    // OMS e handoff são recursos internos já presentes no app; não representam
    // uma conexão externa nem substituem a verificação real da Meta acima.
    oms: true,
    handoff: true,
  });
  const missing = missingOnboardingRequirements(checklist);
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

import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildOnboardingChecklist } from "@/lib/admin-onboarding/checklist";
import { companyProfileSchema, operationSchema, operatorSettingsSchema } from "@/lib/admin-onboarding/schema";
import { isSarahMemoryPublished } from "@/lib/admin-onboarding/sarah-memory";
import { hasAcceptedTeamMembership } from "@/lib/admin-onboarding/team-membership";
import { deliverySettingsFromSarahRules } from "@/lib/foodservice/delivery-policy";
import { OnboardingWizard } from "./_client";

export const dynamic = "force-dynamic";

interface PageProps { params: Promise<{ id: string }> }
type Row = Record<string, unknown>;
const obj = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

export default async function TenantOnboardingPage({ params }: PageProps) {
  await requirePlatformAdmin();
  const { id } = await params;
  const admin = createAdminClient();
  const { data: org } = await admin.from("organizations")
    .select("id,slug,display_name,legal_name,cnpj,settings,onboarding_state,onboarded_at")
    .eq("id", id).maybeSingle();
  if (!org) notFound();

  const [categoriesRes, productsRes, groupsRes, modifiersRes, agentsRes, memoryRes, channelRes] = await Promise.all([
    admin.from("food_categories").select("id,name,is_active,sort_order").eq("organization_id", id).order("sort_order"),
    admin.from("food_products").select("id,category_id,name,description,price_cents,is_available,sort_order").eq("organization_id", id).order("sort_order").limit(250),
    admin.from("food_modifier_groups").select("id,product_id,name,min_select,max_select,is_required,is_active,sort_order").eq("organization_id", id).order("sort_order"),
    admin.from("food_modifiers").select("id,group_id,name,price_delta_cents,is_available,sort_order").eq("organization_id", id).order("sort_order"),
    admin.from("ai_agents").select("id,name,published_version_id").eq("organization_id", id).not("published_version_id", "is", null),
    admin.from("org_memory_pointers").select("version_id").eq("organization_id", id).maybeSingle(),
    admin.from("channel_sessions").select("id,status").eq("organization_id", id).eq("provider", "meta_cloud").eq("status", "WORKING").limit(1),
  ]);

  const settings = obj(org.settings);
  const foodservice = obj(settings.foodservice);
  const setup = obj(obj(org.onboarding_state).foodservice_setup);
  const company = obj(foodservice.company ?? setup.company);
  const sarah = obj(foodservice.sarah ?? setup.sarah);
  const operation = obj(foodservice.operation ?? setup.operation);
  const storedPolicy = obj(operation.delivery_policy);
  const deliverySeed = Object.keys(storedPolicy).length > 0
    ? null
    : deliverySettingsFromSarahRules(
      typeof sarah.rules === "string" ? sarah.rules : "",
      Array.isArray(operation.service_areas) ? operation.service_areas.filter((area): area is string => typeof area === "string") : [],
    );
  const operationForWizard = {
    ...operation,
    ...(deliverySeed ? { delivery_policy: deliverySeed.policy } : {}),
    delivery_policy_required: operation.delivery_policy_required === true || deliverySeed !== null,
  };
  const operator = obj(foodservice.operator ?? setup.operator);
  const operatorRole = operator.role === "manager" ? "manager" : "agent";
  const operatorMembership = await hasAcceptedTeamMembership(
    admin, id, String(operator.email ?? ""), operatorRole,
  );
  const publishedVersionId = memoryRes.data?.version_id;
  const memoryVersionRes = publishedVersionId
    ? await admin.from("org_memory_versions").select("id,content")
      .eq("organization_id", id).eq("id", publishedVersionId).maybeSingle()
    : { data: null, error: null };
  const categories = (categoriesRes.data ?? []) as Array<{ id: string; name: string; is_active: boolean; sort_order: number }>;
  const groups = (groupsRes.data ?? []) as Array<{ id: string; product_id: string; name: string; min_select: number; max_select: number; is_required: boolean; is_active: boolean }>;
  const modifiers = (modifiersRes.data ?? []) as Array<{ id: string; group_id: string; name: string; price_delta_cents: number; is_available: boolean }>;
  const products = ((productsRes.data ?? []) as Array<{ id: string; category_id: string | null; name: string; description: string | null; price_cents: number; is_available: boolean; sort_order: number }>).map((product) => ({
    ...product,
    category_name: categories.find((category) => category.id === product.category_id)?.name ?? "Sem categoria",
    modifier_groups: groups.filter((group) => group.product_id === product.id).map((group) => ({
      name: group.name,
      required: group.is_required,
      modifiers: modifiers.filter((modifier) => modifier.group_id === group.id).map((modifier) => ({
        name: modifier.name, price_delta_cents: modifier.price_delta_cents, available: modifier.is_available,
      })),
    })),
  }));
  const publishedAgents = agentsRes.data ?? [];
  const activeProducts = products.filter((product) => product.is_available).length;
  const memoryReady = !memoryVersionRes.error && isSarahMemoryPublished(
    sarah, publishedVersionId, setup.memory_version_id, memoryVersionRes.data?.content,
  );
  const metaReady = (channelRes.data ?? []).length > 0;
  const companyReady = companyProfileSchema.safeParse(company).success;
  const operationReady = operationSchema.safeParse(operationForWizard).success
    && (!operation.delivery_enabled || operationForWizard.delivery_policy_required !== true || Object.keys(storedPolicy).length > 0);
  const catalogReady = activeProducts > 0;
  const checklist = buildOnboardingChecklist({
    company: companyReady,
    operation: operationReady,
    sarah: memoryReady && publishedAgents.length > 0,
    catalog: catalogReady,
    operator: operatorSettingsSchema.safeParse(operator).success && operatorMembership === "accepted",
    whatsapp: metaReady,
    oms: true,
    omsTested: false,
    handoff: true,
    handoffTested: false,
  });
  const canActivate = checklist.every((item) => item.activationReady);
  const rawCompleted = setup.completed_steps;
  const completedSteps = Array.isArray(rawCompleted) ? rawCompleted.filter((value): value is string => typeof value === "string") : [];
  const currentStep = typeof setup.current_step === "string" ? setup.current_step : "company";
  const storedInvite = obj(setup.team_invite);
  const inviteIsPending =
    typeof storedInvite.invite_id === "string";
  const inviteStatus = operatorMembership === "accepted" ? "accepted" as const : inviteIsPending ? "pending" as const : "none" as const;

  return <OnboardingWizard
    organization={{ id: org.id, slug: org.slug, name: org.display_name, legalName: org.legal_name ?? "" }}
    initial={{ company, operation: operationForWizard, sarah, operator, completedSteps, currentStep, status: typeof setup.status === "string" ? setup.status : null, inviteStatus }}
    catalog={{ categories, products }}
    checklist={checklist}
    canActivate={canActivate}
    activeProducts={activeProducts}
  />;
}

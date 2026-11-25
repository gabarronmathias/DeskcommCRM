import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
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

  const [categoriesRes, productsRes, groupsRes, modifiersRes, memberRes, agentsRes, memoryRes, channelRes] = await Promise.all([
    admin.from("food_categories").select("id,name,is_active,sort_order").eq("organization_id", id).order("sort_order"),
    admin.from("food_products").select("id,category_id,name,description,price_cents,is_available,sort_order").eq("organization_id", id).order("sort_order").limit(250),
    admin.from("food_modifier_groups").select("id,product_id,name,min_select,max_select,is_required,is_active,sort_order").eq("organization_id", id).order("sort_order"),
    admin.from("food_modifiers").select("id,group_id,name,price_delta_cents,is_available,sort_order").eq("organization_id", id).order("sort_order"),
    admin.from("user_organizations").select("user_id", { count: "exact", head: true })
      .eq("organization_id", id).eq("role", "agent").not("accepted_at", "is", null).is("revoked_at", null),
    admin.from("ai_agents").select("id,name,published_version_id").eq("organization_id", id).not("published_version_id", "is", null),
    admin.from("org_memory_pointers").select("version_id").eq("organization_id", id).maybeSingle(),
    admin.from("channel_sessions").select("id,status").eq("organization_id", id).eq("provider", "meta_cloud").eq("status", "WORKING").limit(1),
  ]);

  const settings = obj(org.settings);
  const foodservice = obj(settings.foodservice);
  const setup = obj(obj(org.onboarding_state).foodservice_setup);
  const company = obj(foodservice.company ?? setup.company);
  const operation = obj(foodservice.operation ?? setup.operation);
  const sarah = obj(foodservice.sarah ?? setup.sarah);
  const operator = obj(foodservice.operator ?? setup.operator);
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
  const memoryReady = Boolean(memoryRes.data?.version_id && sarah.name);
  const metaReady = (channelRes.data ?? []).length > 0;
  const companyReady = Boolean(company.responsible_name && company.sarah_name);
  const operationReady = Object.keys(operation).length > 0;
  const catalogReady = activeProducts > 0;
  const checklist = [
    { key: "company", label: "Empresa configurada", pass: companyReady },
    { key: "operation", label: "Operação configurada", pass: operationReady },
    { key: "sarah", label: "Sarah configurada e publicada", pass: memoryReady && publishedAgents.length > 0 },
    { key: "catalog", label: "Catálogo disponível", pass: catalogReady },
    { key: "operator", label: "Operador associado e convite aceito", pass: Boolean(operator.email && (memberRes.count ?? 0) > 0) },
    { key: "whatsapp", label: "WhatsApp Meta conectado", pass: metaReady },
    // The cart is activated by the final action; checking is_enabled here would
    // make activation impossible because the checklist would depend on itself.
    { key: "cart", label: "Carrinho disponível", pass: catalogReady },
    { key: "oms", label: "Pedidos e OMS disponíveis", pass: true },
    { key: "handoff", label: "Handoff disponível", pass: true },
  ];
  const canActivate = checklist.every((item) => item.pass);
  const rawCompleted = setup.completed_steps;
  const completedSteps = Array.isArray(rawCompleted) ? rawCompleted.filter((value): value is string => typeof value === "string") : [];
  const currentStep = typeof setup.current_step === "string" ? setup.current_step : "company";

  return <OnboardingWizard
    organization={{ id: org.id, slug: org.slug, name: org.display_name, legalName: org.legal_name ?? "" }}
    initial={{ company, operation, sarah, operator, completedSteps, currentStep, status: typeof setup.status === "string" ? setup.status : null }}
    catalog={{ categories, products }}
    checklist={checklist}
    canActivate={canActivate}
    activeProducts={activeProducts}
  />;
}

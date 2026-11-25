"use client";

import { useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ImpersonateButton } from "@/components/admin/ImpersonateButton";
import {
  activateFoodservice,
  createCatalogCategory,
  createCatalogProduct,
  goToOnboardingStep,
  publishSarahMemory,
  saveCompanyProfile,
  saveOperationSettings,
  saveSarahDraftSettings,
  saveOperatorSettings,
  updateCatalogProduct,
} from "@/app/actions/admin/onboarding";
import type { OnboardingStep } from "@/lib/admin-onboarding/schema";

const STEPS: { key: OnboardingStep; title: string; short: string }[] = [
  { key: "company", title: "Empresa", short: "Empresa" },
  { key: "operation", title: "Operação", short: "Operação" },
  { key: "catalog", title: "Cardápio", short: "Cardápio" },
  { key: "sarah", title: "Sarah", short: "Sarah" },
  { key: "team", title: "Equipe", short: "Equipe" },
  { key: "whatsapp", title: "WhatsApp", short: "WhatsApp" },
  { key: "checklist", title: "Teste e ativação", short: "Ativação" },
];
const DAYS = [
  ["mon", "Seg"], ["tue", "Ter"], ["wed", "Qua"], ["thu", "Qui"],
  ["fri", "Sex"], ["sat", "Sáb"], ["sun", "Dom"],
] as const;
const PAYMENTS = [["pix", "Pix"], ["cash", "Dinheiro"], ["credit_card", "Crédito"], ["debit_card", "Débito"]] as const;

type Company = { responsible_name?: string; address?: string; phone?: string; sarah_name?: string };
type Operation = {
  business_days?: string[]; opens_at?: string; closes_at?: string; delivery_enabled?: boolean;
  pickup_enabled?: boolean; service_areas?: string[]; delivery_fee_cents?: number;
  minimum_order_cents?: number; average_prep_minutes?: number; payment_methods?: string[];
};
type Sarah = {
  name?: string; greeting?: string; rules?: string; commercial_guidance?: string;
  priority_products?: string; upsell_guidance?: string; handoff_guidance?: string;
};
type Operator = { name?: string; email?: string; role?: "agent" | "manager"; handoff_responsible?: boolean };
type Product = {
  id: string; category_id: string | null; category_name: string; name: string;
  description: string | null; price_cents: number; is_available: boolean;
  modifier_groups: { name: string; required: boolean; modifiers: { name: string; price_delta_cents: number; available: boolean }[] }[];
};
type Category = { id: string; name: string; is_active: boolean; sort_order: number };
type Check = { key: string; label: string; pass: boolean };

interface Props {
  organization: { id: string; slug: string; name: string; legalName: string };
  initial: { company: Company; operation: Operation; sarah: Sarah; operator: Operator; completedSteps: string[]; currentStep: string; status: string | null };
  catalog: { categories: Category[]; products: Product[] };
  checklist: Check[];
  canActivate: boolean;
  activeProducts: number;
}

const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const amount = (value: unknown, fallback = 0) => typeof value === "number" ? (value / 100).toFixed(2) : fallback.toFixed(2);
const parseCents = (value: string) => Math.round(Number(value.replace(",", ".")) * 100);

export function OnboardingWizard({ organization, initial, catalog, checklist, canActivate, activeProducts }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const startIndex = Math.max(0, STEPS.findIndex((step) => step.key === initial.currentStep));
  const [activeIndex, setActiveIndex] = useState(startIndex);
  const step = STEPS[activeIndex]!;
  const [company, setCompany] = useState({
    responsible_name: text(initial.company.responsible_name), address: text(initial.company.address),
    phone: text(initial.company.phone), sarah_name: text(initial.company.sarah_name, "Sarah"),
  });
  const [operation, setOperation] = useState({
    business_days: initial.operation.business_days ?? ["mon", "tue", "wed", "thu", "fri", "sat"],
    opens_at: text(initial.operation.opens_at, "18:00"), closes_at: text(initial.operation.closes_at, "23:00"),
    delivery_enabled: initial.operation.delivery_enabled ?? true, pickup_enabled: initial.operation.pickup_enabled ?? true,
    service_areas: (initial.operation.service_areas ?? []).join(", "),
    delivery_fee: amount(initial.operation.delivery_fee_cents), minimum_order: amount(initial.operation.minimum_order_cents),
    average_prep_minutes: String(initial.operation.average_prep_minutes ?? 45),
    payment_methods: initial.operation.payment_methods ?? ["pix", "credit_card", "debit_card"],
  });
  const [sarah, setSarah] = useState({
    name: text(initial.sarah.name, company.sarah_name), greeting: text(initial.sarah.greeting),
    rules: text(initial.sarah.rules), commercial_guidance: text(initial.sarah.commercial_guidance),
    priority_products: text(initial.sarah.priority_products), upsell_guidance: text(initial.sarah.upsell_guidance),
    handoff_guidance: text(initial.sarah.handoff_guidance),
  });
  const [operator, setOperator] = useState({
    name: text(initial.operator.name), email: text(initial.operator.email),
    role: initial.operator.role ?? "agent" as const,
    handoff_responsible: initial.operator.handoff_responsible ?? true,
  });
  const [teamSaved, setTeamSaved] = useState(initial.completedSteps.includes("team"));
  const [categoryName, setCategoryName] = useState("");
  const [newProduct, setNewProduct] = useState({ category_id: "", name: "", description: "", price: "" });

  function notifyResult(result: { ok: boolean; error?: string }) {
    if (!result.ok) { toast.error(result.error ?? "Não foi possível salvar."); return false; }
    toast.success("Progresso salvo.");
    router.refresh();
    return true;
  }

  function saveCurrentAndMove(target: number) {
    startTransition(async () => {
      let result: { ok: boolean; error?: string } = { ok: true };
      if (step.key === "company") result = await saveCompanyProfile(organization.id, company);
      if (step.key === "operation") result = await saveOperationSettings(organization.id, {
        ...operation,
        service_areas: operation.service_areas.split(/[,\n]/).map((area) => area.trim()).filter(Boolean),
        delivery_fee_cents: parseCents(operation.delivery_fee), minimum_order_cents: parseCents(operation.minimum_order),
        average_prep_minutes: Number(operation.average_prep_minutes),
      });
      if (step.key === "sarah") result = await saveSarahDraftSettings(organization.id, sarah);
      if (step.key === "team") result = await saveOperatorSettings(organization.id, operator);
      if (["catalog", "team", "whatsapp", "checklist"].includes(step.key)) {
        result = await goToOnboardingStep(organization.id, step.key);
      }
      if (!notifyResult(result)) return;
      if (step.key === "team") setTeamSaved(true);
      const next = Math.max(0, Math.min(STEPS.length - 1, target));
      setActiveIndex(next);
      const progress = await goToOnboardingStep(organization.id, STEPS[next]!.key);
      if (!progress.ok) toast.error(progress.error ?? "Não foi possível salvar o ponto de retomada.");
    });
  }

  function navigateOnly(target: number) {
    const next = Math.max(0, Math.min(STEPS.length - 1, target));
    setActiveIndex(next);
    startTransition(async () => {
      const result = await goToOnboardingStep(organization.id, STEPS[next]!.key);
      if (!result.ok) toast.error(result.error ?? "Não foi possível atualizar a etapa atual.");
    });
  }

  function publishSarah() {
    startTransition(async () => {
      const result = await publishSarahMemory(organization.id, sarah);
      if (!result.ok) {
        toast.error(result.error ?? "Não foi possível publicar as orientações.");
        return;
      }
      toast.success(result.unchanged
        ? `Estas orientações já estão publicadas na versão ${result.versionNumber}.`
        : `Orientações publicadas na versão ${result.versionNumber}.`);
      router.refresh();
    });
  }

  function saveSarahDraft() {
    startTransition(async () => {
      const result = await saveSarahDraftSettings(organization.id, sarah);
      if (!result.ok) {
        toast.error(result.error ?? "Não foi possível salvar o rascunho.");
        return;
      }
      toast.success("Rascunho das orientações salvo. Ainda não foi publicado.");
      router.refresh();
    });
  }

  function activate() {
    startTransition(async () => {
      const result = await activateFoodservice(organization.id);
      if (!notifyResult(result)) return;
      toast.success("Operação ativada.");
    });
  }

  const isCompleted = (key: string) => initial.completedSteps.includes(key);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Implantação da empresa</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">{organization.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Continue quando quiser; cada etapa salva seu progresso.</p>
        </div>
        {initial.status === "ACTIVE" && <Badge variant="success">Operação ativa</Badge>}
      </header>

      <nav aria-label="Etapas da implantação" className="space-y-3">
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${((activeIndex + 1) / STEPS.length) * 100}%` }} />
        </div>
        <ol className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {STEPS.map((item, index) => (
            <li key={item.key}>
              <button type="button" onClick={() => saveCurrentAndMove(index)}
                aria-current={index === activeIndex ? "step" : undefined}
                className={`w-full rounded-md border px-2 py-2 text-left text-xs ${index === activeIndex ? "border-primary bg-primary/5 font-semibold" : "hover:bg-muted/50"}`}>
                <span className="block text-muted-foreground">{index + 1} {isCompleted(item.key) ? "✓" : ""}</span>
                <span>{item.short}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className="text-sm font-medium">Etapa {activeIndex + 1} de 7 · {step.title}</p>
      </nav>

      <Card>
        <CardHeader><CardTitle>{step.title}</CardTitle></CardHeader>
        <CardContent className="space-y-6">
          {step.key === "company" && <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome da empresa"><Input value={organization.name} disabled /></Field>
            <Field label="Nome de Sarah"><Input value={company.sarah_name} onChange={(e) => setCompany({ ...company, sarah_name: e.target.value })} /></Field>
            <Field label="Responsável"><Input value={company.responsible_name} onChange={(e) => setCompany({ ...company, responsible_name: e.target.value })} /></Field>
            <Field label="Telefone"><Input value={company.phone} onChange={(e) => setCompany({ ...company, phone: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Field label="Endereço"><Input value={company.address} onChange={(e) => setCompany({ ...company, address: e.target.value })} /></Field></div>
            <p className="sm:col-span-2 text-xs text-muted-foreground">O nome público e os dados legais já foram salvos no cadastro da empresa.</p>
          </div>}

          {step.key === "operation" && <div className="space-y-5">
            <div className="space-y-2"><Label>Dias de funcionamento</Label><div className="flex flex-wrap gap-3">
              {DAYS.map(([id, label]) => <label key={id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={operation.business_days.includes(id)} onChange={(e) => setOperation({ ...operation, business_days: e.target.checked ? [...operation.business_days, id] : operation.business_days.filter((day) => day !== id) })} />{label}</label>)}
            </div></div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Abre"><Input type="time" value={operation.opens_at} onChange={(e) => setOperation({ ...operation, opens_at: e.target.value })} /></Field>
              <Field label="Fecha"><Input type="time" value={operation.closes_at} onChange={(e) => setOperation({ ...operation, closes_at: e.target.value })} /></Field>
              <Field label="Prazo médio (minutos)"><Input type="number" min="1" max="600" value={operation.average_prep_minutes} onChange={(e) => setOperation({ ...operation, average_prep_minutes: e.target.value })} /></Field>
            </div>
            <div className="flex flex-wrap gap-6 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={operation.delivery_enabled} onChange={(e) => setOperation({ ...operation, delivery_enabled: e.target.checked })} />Entrega</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={operation.pickup_enabled} onChange={(e) => setOperation({ ...operation, pickup_enabled: e.target.checked })} />Retirada</label>
            </div>
            {operation.delivery_enabled && <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Bairros/regiões atendidos"><Input value={operation.service_areas} onChange={(e) => setOperation({ ...operation, service_areas: e.target.value })} placeholder="Centro, Jardim das Flores" /></Field>
              <Field label="Taxa de entrega (R$)"><Input type="number" min="0" step="0.01" value={operation.delivery_fee} onChange={(e) => setOperation({ ...operation, delivery_fee: e.target.value })} /></Field>
              <Field label="Pedido mínimo (R$)"><Input type="number" min="0" step="0.01" value={operation.minimum_order} onChange={(e) => setOperation({ ...operation, minimum_order: e.target.value })} /></Field>
            </div>}
            <div className="space-y-2"><Label>Formas de pagamento</Label><div className="flex flex-wrap gap-4">
              {PAYMENTS.map(([id, label]) => <label key={id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={operation.payment_methods.includes(id)} onChange={(e) => setOperation({ ...operation, payment_methods: e.target.checked ? [...operation.payment_methods, id] : operation.payment_methods.filter((method) => method !== id) })} />{label}</label>)}
            </div></div>
            <p className="text-xs text-muted-foreground">Esses dados ficam salvos na configuração de operação da empresa para consulta e continuidade da implantação.</p>
          </div>}

          {step.key === "catalog" && <div className="space-y-6">
            <p className="text-sm text-muted-foreground">Categorias: {catalog.categories.length} · Produtos disponíveis: {activeProducts} de {catalog.products.length}</p>
            <div className="space-y-3">
              {catalog.products.map((product) => <CatalogProductCard key={product.id} organizationId={organization.id} product={product} />)}
              {catalog.products.length === 0 && <p className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">Ainda não há produtos. Crie uma categoria e cadastre os primeiros itens do cardápio.</p>}
            </div>
            <div className="grid gap-6 rounded-lg border p-4 lg:grid-cols-2">
              <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); startTransition(async () => { const result = await createCatalogCategory(organization.id, { name: String(data.get("name") ?? "") }); if (notifyResult(result)) { setCategoryName(""); form.reset(); } }); }}>
                <h3 className="font-medium">Adicionar categoria</h3>
                <Field label="Nome da categoria"><Input name="name" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} required maxLength={80} /></Field>
                <Button type="submit" disabled={pending}>Criar categoria</Button>
              </form>
              <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); startTransition(async () => { const result = await createCatalogProduct(organization.id, { category_id: newProduct.category_id, name: newProduct.name, description: newProduct.description, price_cents: parseCents(newProduct.price) }); if (notifyResult(result)) setNewProduct({ category_id: "", name: "", description: "", price: "" }); }); }}>
                <h3 className="font-medium">Adicionar produto</h3>
                <Field label="Categoria"><select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={newProduct.category_id} onChange={(e) => setNewProduct({ ...newProduct, category_id: e.target.value })} required><option value="">Selecione</option>{catalog.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field>
                <Field label="Nome"><Input value={newProduct.name} onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })} required maxLength={120} /></Field>
                <Field label="Descrição"><Textarea value={newProduct.description} onChange={(e) => setNewProduct({ ...newProduct, description: e.target.value })} maxLength={2000} /></Field>
                <Field label="Preço (R$)"><Input type="number" min="0" step="0.01" value={newProduct.price} onChange={(e) => setNewProduct({ ...newProduct, price: e.target.value })} required /></Field>
                <Button type="submit" disabled={pending || catalog.categories.length === 0}>Adicionar produto</Button>
              </form>
            </div>
            <p className="text-xs text-muted-foreground">Variações e adicionais existentes aparecem em cada produto. Para editar essas opções, use a tela de catálogo da empresa quando disponível; este passo não altera grupos ou valores dos adicionais.</p>
          </div>}

          {step.key === "sarah" && <div className="space-y-4">
            <p className="text-sm text-muted-foreground">As alterações ficam como rascunho ao salvar esta etapa. Só chegam à memória usada pela Sarah quando você clicar em publicar.</p>
            <Field label="Nome usado no atendimento"><Input value={sarah.name} onChange={(e) => setSarah({ ...sarah, name: e.target.value })} maxLength={80} /></Field>
            <Field label="Mensagem inicial"><Textarea value={sarah.greeting} onChange={(e) => setSarah({ ...sarah, greeting: e.target.value })} maxLength={1200} /></Field>
            <Field label="Regras importantes"><Textarea value={sarah.rules} onChange={(e) => setSarah({ ...sarah, rules: e.target.value })} maxLength={8000} /></Field>
            <Field label="Orientações comerciais"><Textarea value={sarah.commercial_guidance} onChange={(e) => setSarah({ ...sarah, commercial_guidance: e.target.value })} maxLength={4000} /></Field>
            <Field label="Produtos que deseja priorizar"><Textarea value={sarah.priority_products} onChange={(e) => setSarah({ ...sarah, priority_products: e.target.value })} maxLength={2000} /></Field>
            <Field label="Orientação de venda adicional"><Textarea value={sarah.upsell_guidance} onChange={(e) => setSarah({ ...sarah, upsell_guidance: e.target.value })} maxLength={2000} /></Field>
            <Field label="Quando deve chamar uma pessoa"><Textarea value={sarah.handoff_guidance} onChange={(e) => setSarah({ ...sarah, handoff_guidance: e.target.value })} maxLength={2000} /></Field>
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={saveSarahDraft} disabled={pending}>{pending ? "Salvando..." : "Salvar rascunho"}</Button>
              <Button onClick={publishSarah} disabled={pending}>{pending ? "Publicando..." : "Publicar orientações da Sarah"}</Button>
            </div>
            <div className="rounded-md border p-4"><p className="mb-3 text-sm">Crie ou revise o agente e publique a configuração com as ferramentas existentes do CRM.</p><ImpersonateButton organizationId={organization.id} displayName={organization.name} redirectTo="/app/ai/agents/new" /></div>
          </div>}

          {step.key === "team" && <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome do operador"><Input value={operator.name} onChange={(e) => { setTeamSaved(false); setOperator({ ...operator, name: e.target.value }); }} maxLength={120} /></Field>
              <Field label="E-mail"><Input type="email" value={operator.email} onChange={(e) => { setTeamSaved(false); setOperator({ ...operator, email: e.target.value }); }} maxLength={254} /></Field>
            </div>
            <p className="text-sm text-muted-foreground">O convite será enviado como atendente. Depois que a pessoa aceitar, poderá visualizar pedidos e assumir conversas.</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={operator.handoff_responsible} onChange={(e) => { setTeamSaved(false); setOperator({ ...operator, handoff_responsible: e.target.checked }); }} />Responsável principal pelo handoff</label>
            <ImpersonateButton organizationId={organization.id} displayName={organization.name} redirectTo="/app/team/invite" disabled={!operator.email || !teamSaved} disabledReason="Informe nome e e-mail e salve esta etapa antes de abrir o convite." />
            <p className="text-xs text-muted-foreground">Salve e avance para gravar estes dados. O e-mail ficará preenchido na tela de convite do CRM.</p>
          </div>}

          {step.key === "whatsapp" && <div className="space-y-4">
            <p className="text-sm text-muted-foreground">A conexão usa a API oficial da Meta. O token é validado e armazenado pela tela de conexões do CRM.</p>
            <ImpersonateButton organizationId={organization.id} displayName={organization.name} redirectTo="/app/connections?aba=oficial" />
            <p className="text-xs text-muted-foreground">Não use QR code ou WhatsApp Web. Conclua a conexão oficial e volte para o checklist.</p>
          </div>}

          {step.key === "checklist" && <div className="space-y-5">
            <p className="text-sm text-muted-foreground">Revise os itens pendentes. A ativação só fica disponível quando todos os requisitos estiverem atendidos.</p>
            <ul className="space-y-2">
              {checklist.map((item) => <li key={item.key} className="flex items-center justify-between gap-4 rounded-md border px-4 py-3 text-sm">
                <span>{item.label}</span><Badge variant={item.pass ? "success" : "warning"}>{item.pass ? "PASS" : "PENDENTE"}</Badge>
              </li>)}
            </ul>
            <Button onClick={activate} disabled={pending || !canActivate}>{pending ? "Ativando..." : "ATIVAR OPERAÇÃO"}</Button>
            {!canActivate && <p className="text-xs text-muted-foreground">Atenda os itens pendentes e retorne aqui para ativar.</p>}
            {initial.status === "ACTIVE" && <p role="status" className="text-sm font-medium text-emerald-700">Empresa ativada. A implantação foi concluída.</p>}
          </div>}

          <div className="flex items-center justify-between border-t pt-4">
            <Button variant="outline" onClick={() => navigateOnly(activeIndex - 1)} disabled={pending || activeIndex === 0}>Voltar</Button>
            {activeIndex < STEPS.length - 1 && <Button onClick={() => saveCurrentAndMove(activeIndex + 1)} disabled={pending}>{pending ? "Salvando..." : "Salvar e continuar"}</Button>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>;
}

function CatalogProductCard({ organizationId, product }: { organizationId: string; product: Product }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [price, setPrice] = useState((product.price_cents / 100).toFixed(2));
  const [available, setAvailable] = useState(product.is_available);
  return <div className="space-y-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="font-medium">{product.name}</p><p className="text-xs text-muted-foreground">{product.category_name}</p>{product.description && <p className="mt-1 text-sm text-muted-foreground">{product.description}</p>}</div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} />Disponível</label>
    </div>
    <div className="flex items-end gap-3">
      <Field label="Preço (R$)"><Input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className="w-36" /></Field>
      <Button disabled={pending} onClick={() => startTransition(async () => {
        const result = await updateCatalogProduct(organizationId, { product_id: product.id, price_cents: parseCents(price), is_available: available });
        if (!result.ok) toast.error(result.error ?? "Produto não atualizado.");
        else { toast.success("Produto atualizado."); router.refresh(); }
      })}>{pending ? "Salvando..." : "Salvar produto"}</Button>
    </div>
    {product.modifier_groups.length > 0 && <div className="border-t pt-3 text-xs text-muted-foreground"><p className="font-medium text-foreground">Adicionais e variações</p>{product.modifier_groups.map((group) => <div key={group.name} className="mt-2"><span>{group.name}{group.required ? " · obrigatório" : ""}</span><p>{group.modifiers.map((modifier) => `${modifier.name}${modifier.price_delta_cents ? ` (+R$ ${(modifier.price_delta_cents / 100).toFixed(2)})` : ""}${modifier.available ? "" : " · indisponível"}`).join(" · ")}</p></div>)}</div>}
  </div>;
}

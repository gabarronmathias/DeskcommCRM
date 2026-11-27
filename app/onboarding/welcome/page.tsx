import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { WelcomeForm } from "./_form";
import { branding } from "@/lib/branding";
import { createClient } from "@/lib/supabase/server";
import { lerRetratoDaInstalacao } from "@/lib/instalacao/retrato";
import { JaEstaPronto } from "../_components/JaEstaPronto";
import { loadOnboardingState } from "@/app/actions/onboarding/_shared";
import { foodserviceActivationPending, foodserviceSetupExists } from "@/lib/onboarding/foodservice-activation-gate";

export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");

  const { state } = await loadOnboardingState(activeOrg.orgId);
  if (foodserviceSetupExists(state)) {
    if (!foodserviceActivationPending(state)) redirect("/app/inbox");
    return (
      <section role="status" className="space-y-3 rounded-lg border bg-background p-6">
        <h2 className="text-xl font-semibold">Implantação em andamento</h2>
        <p className="text-sm text-muted-foreground">
          Esta empresa usa a implantação Foodservice administrada. O fluxo de boas-vindas não altera
          os dados nem conclui a ativação. A operação será liberada quando os requisitos forem
          concluídos no painel de implantação.
        </p>
      </section>
    );
  }

  const supabase = await createClient();
  const retrato = await lerRetratoDaInstalacao({ supabase, orgId: activeOrg.orgId });

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">Boas-vindas ao {branding().name}</h2>
        <p className="text-sm text-muted-foreground">
          Vamos montar quem vai atender seus clientes — e onde ele vai trabalhar.
        </p>
      </header>

      <JaEstaPronto retrato={retrato} />

      {/*
        O instalador NUNCA pergunta o nome do negócio: toda organização nasce
        "Minha Empresa", hardcoded. Mandar esse texto como valor inicial fazia a
        pessoa ter de apagá-lo antes de escrever o nome dela — e quem não
        percebia seguia com o placeholder no cabeçalho do sistema para sempre.
      */}
      <WelcomeForm defaultOrgName={retrato.empresa.aindaSemNomeProprio ? "" : activeOrg.name} />
    </div>
  );
}

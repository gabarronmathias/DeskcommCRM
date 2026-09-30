import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { AgentRow } from "@/hooks/ai/useAgent";
import { AgentsList } from "./_components/AgentsList";
import { projectPublishedAgentModels } from "@/lib/ai/agents/list-model";

export const dynamic = "force-dynamic";

const AGENT_COLUMNS =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at";

export default async function AgentsListPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("ai_agents")
    .select(AGENT_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  const rawAgents = (data ?? []) as unknown as AgentRow[];
  const publishedVersionIds = rawAgents
    .map((agent) => agent.published_version_id)
    .filter((id): id is string => Boolean(id));
  let publishedVersions: Array<{ id: string; provider: string; model: string }> = [];
  if (publishedVersionIds.length) {
    const { data } = await supabase
      .from("ai_agent_versions")
      .select("id, provider, model")
      .eq("organization_id", activeOrg.orgId)
      .in("id", publishedVersionIds);
    publishedVersions = (data ?? []) as typeof publishedVersions;
  }
  const agents = projectPublishedAgentModels(rawAgents, publishedVersions);
  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents de IA</h1>
          <p className="text-sm text-muted-foreground">
            Configure o comportamento dos agents que respondem no WhatsApp.
          </p>
        </div>
      </header>
      <AgentsList initialData={agents} canWrite={canWrite} />
    </div>
  );
}

export interface PublishedAgentModel {
  id: string;
  provider: string | null;
  model: string | null;
}

type AgentListModel = {
  model: string;
  published_version_id?: string | null;
};

/**
 * The runtime uses ai_agent_versions for versioned agents. Keep list cards on
 * that same source of truth instead of the legacy ai_agents.model column.
 */
export function projectPublishedAgentModels<T extends AgentListModel>(
  agents: readonly T[],
  versions: readonly PublishedAgentModel[],
): Array<Omit<T, "model"> & { model: string }> {
  const byId = new Map(versions.map((version) => [version.id, version]));

  return agents.map((agent) => {
    if (!agent.published_version_id) return { ...agent, model: agent.model };

    const version = byId.get(agent.published_version_id);
    if (!version?.provider || !version.model) {
      return { ...agent, model: "indisponível" };
    }

    return { ...agent, model: `${version.provider}/${version.model}` };
  });
}

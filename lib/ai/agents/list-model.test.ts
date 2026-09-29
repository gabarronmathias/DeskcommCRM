import { describe, expect, it } from "vitest";
import { projectPublishedAgentModels } from "./list-model";

describe("projectPublishedAgentModels", () => {
  it("uses the published version instead of the stale legacy model", () => {
    const agents = [
      { id: "sarah", model: "anthropic/claude-sonnet-4", published_version_id: "v8" },
    ];

    expect(
      projectPublishedAgentModels(agents, [
        { id: "v8", provider: "openai", model: "gpt-5-mini" },
      ]),
    ).toEqual([
      { id: "sarah", model: "openai/gpt-5-mini", published_version_id: "v8" },
    ]);
  });

  it("preserves the legacy model when there is no published version", () => {
    const agents = [{ id: "legacy", model: "openai/gpt-4o", published_version_id: null }];

    expect(projectPublishedAgentModels(agents, [])).toEqual(agents);
  });

  it("does not present a stale model when the published version cannot be loaded", () => {
    const agents = [
      { id: "sarah", model: "anthropic/claude-sonnet-4", published_version_id: "missing" },
    ];

    expect(projectPublishedAgentModels(agents, [])).toEqual([
      { id: "sarah", model: "indisponível", published_version_id: "missing" },
    ]);
  });
});

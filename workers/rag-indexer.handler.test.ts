import { describe, expect, it } from "vitest";

import { ragIndexerHandler } from "./rag-indexer.handler";

describe("rag-indexer event subscriptions", () => {
  it("não recebe eventos de catálogo Nuvemshop", () => {
    expect(ragIndexerHandler.events).toEqual(["knowledge_source.updated"]);
  });
});

import { describe, expect, it } from "vitest";
import { makeArtifactRevision, makeCommand, makeOutputSlot, makeScopeView } from "../__fixtures__/read-models";
import { selectActionableScopes, selectArtifactCommands } from "./decision-queue";

describe("projected decision queue", () => {
  it("keeps actionable scopes in projection order", () => {
    const command = makeCommand();
    const scopes = [
      makeScopeView({ scope_id: "first", commands: [command] }),
      makeScopeView({ scope_id: "waiting", commands: [] }),
      makeScopeView({ scope_id: "last", commands: [command] }),
    ];
    expect(selectActionableScopes(scopes).map((scope) => scope.scope_id)).toEqual(["first", "last"]);
  });

  it("offers an artifact command only for its observed revision target", () => {
    const revision = makeArtifactRevision();
    const command = makeCommand();
    const scope = makeScopeView({ commands: [command], outputs: [makeOutputSlot({ current_revision: revision })],
      command_targets: { approve: [{ identity: revision.id, version: revision.version }] } });
    expect(selectArtifactCommands(scope, revision.id)).toEqual([command]);
    expect(selectArtifactCommands(scope, "earlier-revision")).toEqual([]);
  });
});

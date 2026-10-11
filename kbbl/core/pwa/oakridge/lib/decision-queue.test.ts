import { describe, expect, it } from "vitest";
import { makeArtifactRevision, makeCommand, makeInboxCommand, makeOutputSlot, makeScopeView } from "../__fixtures__/read-models";
import { selectActionableScopes, selectArtifactCommands, selectStableOperatorDecisionQueue } from "./decision-queue";

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

  it("keeps a departed item settled in its old row", () => {
    const a = makeInboxCommand({ key: "a" });
    const b = makeInboxCommand({ key: "b" });
    const c = makeInboxCommand({ key: "c" });
    expect(selectStableOperatorDecisionQueue([a, b, c].map((item) => ({ kind: "live", item })), [b, c]))
      .toEqual([{ kind: "settled", item: a }, { kind: "live", item: b }, { kind: "live", item: c }]);
  });

  it("appends newly arrived work after existing rows despite server reorder", () => {
    const a = makeInboxCommand({ key: "a" });
    const b = makeInboxCommand({ key: "b" });
    const assessment = makeInboxCommand({ key: "assessment" });
    expect(selectStableOperatorDecisionQueue([a, b].map((item) => ({ kind: "live", item })), [assessment, a, b]))
      .toEqual([{ kind: "live", item: a }, { kind: "live", item: b }, { kind: "live", item: assessment }]);
  });
});

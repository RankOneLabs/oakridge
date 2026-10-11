import { describe, expect, it } from "vitest";

import {
  makeBuildBriefFixture, makeCommand, makeRunDetail, makeRunScopeSummary, makeScopeView, makeScopeWithOutput,
} from "../__fixtures__/read-models";
import { selectActionableScopes } from "./decision-queue";
import { selectRunExecutions } from "./run-sessions";
import { selectRunArtifacts, selectRunProgress, selectScopeStatus } from "./run-overview";

describe("generated run overview", () => {
  it("counts completed and actionable scopes", () => {
    const run = makeRunDetail({ scopes: [
      makeRunScopeSummary({ scope_id: "plan", is_terminal: true }),
      makeRunScopeSummary({ scope_id: "build", available_commands: ["approve"] }),
      makeRunScopeSummary({ scope_id: "assess" }),
    ] });
    expect(selectRunProgress(run)).toEqual({ total: 3, complete: 1, needs_attention: 1 });
  });

  it("reports zero progress for a run with no scopes", () => {
    expect(selectRunProgress(makeRunDetail())).toEqual({ total: 0, complete: 0, needs_attention: 0 });
  });

  it("opens an available merge confirmation on its own scope", () => {
    const scope = makeScopeView({ scope_id: "build-1", commands: [makeCommand({ key: "confirm_merged", label: "Confirm merged" })] });
    expect(selectActionableScopes([scope]).map((item) => item.scope_id)).toEqual(["build-1"]);
  });

  it("does not offer actions from a terminal scope", () => {
    const other = makeScopeView({ scope_id: "build-2", commands: [makeCommand({ key: "confirm_merged" })] });
    const terminal = makeScopeView({ scope_id: "build-1", is_terminal: true, commands: [makeCommand({ key: "confirm_merged" })] });
    expect(selectActionableScopes([other, terminal]).find((scope) => scope.scope_id === "build-1")).toBeUndefined();
  });

  it("keeps the available command labels in a live decision scope", () => {
    const scope = makeScopeView({ commands: [makeCommand({ key: "approve", label: "Approve" }), makeCommand({ key: "reject", label: "Reject" })] });
    expect(selectActionableScopes([scope])[0]?.commands.map((command) => command.label)).toEqual(["Approve", "Reject"]);
  });

  it("shows available commands as attention, with terminal state taking precedence", () => {
    expect(selectScopeStatus(makeRunScopeSummary({ available_commands: ["approve"] }))).toBe("attention");
    expect(selectScopeStatus(makeRunScopeSummary({ is_terminal: true, available_commands: ["approve"] }))).toBe("complete");
  });

  it("exposes only published current revisions as artifacts", () => {
    const brief = makeBuildBriefFixture();
    const scopes = [makeScopeWithOutput({ body: brief.body, output_key: "briefs" }), makeScopeView()];
    expect(selectRunArtifacts(scopes).map((artifact) => artifact.revision.body.schema)).toEqual(["brief_body"]);
  });

  it("keeps the execution list empty when no generated scope has an execution", () => {
    expect(selectRunExecutions([makeScopeView()])).toEqual([]);
  });
});

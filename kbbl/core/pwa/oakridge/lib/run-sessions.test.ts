import { describe, expect, test } from "vitest";
import { makeExecutionView, makeScopeView } from "../__fixtures__/read-models";
import { selectRunExecutions } from "./run-sessions";

describe("selectRunExecutions", () => {
  test("retains each execution's owning scope", () => {
    const rows = selectRunExecutions([
      makeScopeView({ scope_id: "scope-build", executions: [makeExecutionView({ id: "execution-build", scope_id: "scope-build" })] }),
      makeScopeView({ scope_id: "scope-assess", executions: [makeExecutionView({ id: "execution-assess", scope_id: "scope-assess" })] }),
    ]);
    expect(rows.map((row) => [row.scope_id, row.execution.id])).toEqual([
      ["scope-build", "execution-build"], ["scope-assess", "execution-assess"],
    ]);
  });

  test("preserves projection order within and across scopes", () => {
    const rows = selectRunExecutions([
      makeScopeView({ scope_id: "scope-build", executions: [
        makeExecutionView({ id: "execution-1", generation: 1 }), makeExecutionView({ id: "execution-2", generation: 2 }),
      ] }),
      makeScopeView({ scope_id: "scope-assess", executions: [makeExecutionView({ id: "execution-3", scope_id: "scope-assess" })] }),
    ]);
    expect(rows.map((row) => row.execution.id)).toEqual(["execution-1", "execution-2", "execution-3"]);
  });

  test("returns no rows when no scope has an execution", () => {
    expect(selectRunExecutions([makeScopeView(), makeScopeView({ scope_id: "scope-2" })])).toEqual([]);
  });
});

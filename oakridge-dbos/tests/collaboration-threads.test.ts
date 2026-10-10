import { expect, test } from "bun:test";
import { revisionCollaborationTarget } from "../src/storage/collaboration";

test("operator edit addresses the nearest preceding agent revision", () => {
  expect(revisionCollaborationTarget("operator-edit", [
    { id: "operator-edit", predecessor_id: "agent-2", execution_id: null },
    { id: "agent-2", predecessor_id: "agent-1", execution_id: "execution-2" },
    { id: "agent-1", predecessor_id: null, execution_id: "execution-1" },
  ])).toEqual({ revision_id: "agent-2", execution_id: "execution-2" });
});

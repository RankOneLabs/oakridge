import { expect, test } from "bun:test";
import { stagesFromReadiness, validateStage, type WorkflowUnit } from "../src/grading/task-stages";
const unit = (unit_id: string, stage: string | null, depends_on: readonly string[] = []): WorkflowUnit =>
  ({ unit_id, stage, depends_on, status: { kind: "not_started" }, artifacts: [{ artifact_key: `${stage}-output` }] });
test("readiness dependencies order arbitrary stages and retain unpublished stages", () => {
  const stages = stagesFromReadiness([unit("last", "release", ["middle"]), unit("root", null), unit("middle", "verify", ["first"]), unit("first", "discover", ["root"])]);
  expect(stages.map((stage) => stage.stage)).toEqual(["discover", "verify", "release"]);
});
test("unknown stage parameters produce a typed error", () => {
  expect(validateStage(stagesFromReadiness([unit("a", "custom")]), "missing")).toEqual({ ok: false, error: { kind: "unknown_stage", stage: "missing" } });
});

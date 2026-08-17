import { expect, test } from "bun:test";

import { evaluateExecutionArtifactContract, releaseStateForArtifact, shouldAwaitArtifactRelease, validateArtifactEmission, withoutReleaseFor, withRelease } from "../src/contracts/evaluate-artifacts";
import type { ArtifactEmission, ArtifactReleaseState, ArtifactRevision } from "../src/domain/artifacts";
import type { CompiledOutputContract } from "../src/domain/compiled-workflow";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";

const output = (release: CompiledOutputContract["release"]): CompiledOutputContract => ({ name: "result", artifact_type: "dev.result", release });
const emission: ArtifactEmission = { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, idempotency_key: "emit-1", payload_hash: "hash" };
const artifact: ArtifactRevision = { id: "revision" as ArtifactId, chain_id: "revision" as ArtifactId, ...emission, version: 1, parent_artifact_id: null, lifecycle: { kind: "current" }, created_at: "2026-08-14T00:00:00Z" };

test("rejects output and artifact-type mismatches before persistence", () => {
  expect(validateArtifactEmission({ ...emission, artifact_type: "wrong" }, [output({ kind: "immediate" })])).toEqual({ ok: false, error: { operation: "evaluate_artifact_contract", output_name: "result", detail: "expected artifact type 'dev.result', received 'wrong'" } });
});

test("a gate keeps a valid artifact from satisfying the execution contract", () => {
  const contract = output({ kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" as const }, { name: "request_revision", disposition: "revise" as const }] }], requires_zero_open_review_items: false, revision_target: "self_stage" });
  const release = releaseStateForArtifact(artifact, contract);
  expect(release.kind).toBe("waiting_gate");
  expect(evaluateExecutionArtifactContract([release], [{ unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result" }])).toEqual({ kind: "waiting_artifacts", missing_outputs: ["0:result"] });
});

test("released required artifacts satisfy the contract independently of executor termination", () => {
  const contract = output({ kind: "immediate" });
  expect(evaluateExecutionArtifactContract([releaseStateForArtifact(artifact, contract)], [{ unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result" }])).toEqual({ kind: "satisfied", artifacts: [artifact] });
});

test("one artifact-collection executor waits for every checkpointed runtime artifact identity", () => {
  const first = { ...artifact, id: "artifact-a" as ArtifactId, unit_id: "a" as UnitId };
  const second = { ...artifact, id: "artifact-b" as ArtifactId, unit_id: "b" as UnitId };
  const expected = [
    { unit_id: "a" as UnitId, output_name: "result", artifact_type: "dev.result" },
    { unit_id: "b" as UnitId, output_name: "result", artifact_type: "dev.result" },
  ];
  expect(evaluateExecutionArtifactContract([{ kind: "released", artifact: first }], expected)).toEqual({ kind: "waiting_artifacts", missing_outputs: ["b:result"] });
  expect(evaluateExecutionArtifactContract([{ kind: "released", artifact: first }, { kind: "released", artifact: second }], expected)).toEqual({ kind: "satisfied", artifacts: [first, second] });
});

const brief = (unit: string, id: string): ArtifactRevision => ({ ...artifact, id: id as ArtifactId, unit_id: unit as UnitId, output_name: "brief", artifact_type: "dev.brief" });
const briefExpected = ["a", "b", "c"].map((unit) => ({ unit_id: unit as UnitId, output_name: "brief", artifact_type: "dev.brief" }));

test("revising one collection artifact leaves its released siblings released", () => {
  let releases: readonly ArtifactReleaseState[] = [];
  for (const unit of ["a", "b", "c"]) releases = withRelease(releases, brief(unit, `brief-${unit}`));
  expect(evaluateExecutionArtifactContract(releases, briefExpected).kind).toBe("satisfied");

  releases = withoutReleaseFor(releases, brief("a", "brief-a-v2"));
  expect(evaluateExecutionArtifactContract(releases, briefExpected)).toEqual({ kind: "waiting_artifacts", missing_outputs: ["a:brief"] });

  releases = withRelease(releases, brief("a", "brief-a-v2"));
  expect(evaluateExecutionArtifactContract(releases, briefExpected).kind).toBe("satisfied");
});

test("re-releasing an artifact replaces its prior release state rather than duplicating it", () => {
  const released = brief("a", "brief-a");
  expect(withRelease(withRelease([], released), released)).toEqual([{ kind: "released", artifact: released }]);
});

test("successful executor termination does not bypass a pending artifact gate", () => {
  const contract = evaluateExecutionArtifactContract([], [{ unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result" }]);
  expect(shouldAwaitArtifactRelease(contract, { kind: "succeeded", metadata: {} }, [])).toBe(true);
  expect(shouldAwaitArtifactRelease(contract, { kind: "failed", code: "executor_failed", detail: "failed before output" }, [])).toBe(false);
});

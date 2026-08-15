import { expect, test } from "bun:test";

import { evaluateExecutionArtifactContract, releaseStateForArtifact, validateArtifactEmission } from "../src/contracts/evaluate-artifacts";
import type { ArtifactEmission, ArtifactRevision } from "../src/domain/artifacts";
import type { CompiledOutputContract } from "../src/domain/compiled-workflow";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";

const output = (release: CompiledOutputContract["release"]): CompiledOutputContract => ({ name: "result", artifact_type: "dev.result", release });
const emission: ArtifactEmission = { run_id: "run" as WorkflowRunId, stage_instance_id: "stage" as StageInstanceId, execution_id: "execution" as ExecutionId, unit_id: "0" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: { done: true }, idempotency_key: "emit-1", payload_hash: "hash" };
const artifact: ArtifactRevision = { id: "revision" as ArtifactId, chain_id: "revision" as ArtifactId, ...emission, version: 1, parent_artifact_id: null, created_at: "2026-08-14T00:00:00Z" };

test("rejects output and artifact-type mismatches before persistence", () => {
  expect(validateArtifactEmission({ ...emission, artifact_type: "wrong" }, [output({ kind: "immediate" })])).toEqual({ ok: false, error: { operation: "evaluate_artifact_contract", output_name: "result", detail: "expected artifact type 'dev.result', received 'wrong'" } });
});

test("a gate keeps a valid artifact from satisfying the execution contract", () => {
  const contract = output({ kind: "gate", steps: [{ type: "artifact_approval", actions: ["approve", "request_revision"] }], requires_zero_open_review_items: false, revision_target: "self_stage" });
  const release = releaseStateForArtifact(artifact, contract);
  expect(release.kind).toBe("waiting_gate");
  expect(evaluateExecutionArtifactContract([contract], [release])).toEqual({ kind: "waiting_artifacts", missing_outputs: ["result"] });
});

test("released required artifacts satisfy the contract independently of executor termination", () => {
  const contract = output({ kind: "immediate" });
  expect(evaluateExecutionArtifactContract([contract], [releaseStateForArtifact(artifact, contract)])).toEqual({ kind: "satisfied", artifacts: [artifact] });
});

test("one artifact-collection executor waits for every checkpointed runtime artifact identity", () => {
  const contracts = [output({ kind: "immediate" })];
  const first = { ...artifact, id: "artifact-a" as ArtifactId, unit_id: "a" as UnitId };
  const second = { ...artifact, id: "artifact-b" as ArtifactId, unit_id: "b" as UnitId };
  const expected = [
    { unit_id: "a" as UnitId, output_name: "result", artifact_type: "dev.result" },
    { unit_id: "b" as UnitId, output_name: "result", artifact_type: "dev.result" },
  ];
  expect(evaluateExecutionArtifactContract(contracts, [{ kind: "released", artifact: first }], expected)).toEqual({ kind: "waiting_artifacts", missing_outputs: ["b:result"] });
  expect(evaluateExecutionArtifactContract(contracts, [{ kind: "released", artifact: first }, { kind: "released", artifact: second }], expected)).toEqual({ kind: "satisfied", artifacts: [first, second] });
});

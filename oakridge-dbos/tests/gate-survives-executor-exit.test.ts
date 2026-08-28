/**
 * A gate exists so a person can review at their own pace. The artifact it
 * guards is released by the execution workflow, so anything that makes that
 * workflow stop waiting strands the unit — the artifact is never released, the
 * gate stays approvable, and the approval lands on a workflow that already
 * returned. Run 13931230 lost a plan exactly this way: approved 12m35s after
 * emission, by which time the agent session had gone.
 */
import { expect, test } from "bun:test";

import { evaluateExecutionArtifactContract, shouldAwaitArtifactRelease } from "../src/contracts/evaluate-artifacts";
import type { ArtifactReleaseState, ArtifactRevision } from "../src/domain/artifacts";
import type { CompiledOutputContract } from "../src/domain/compiled-workflow";
import type { ArtifactId, UnitId } from "../src/domain/primitives";

const artifact = (output_name: string): ArtifactRevision => ({
  id: `${output_name}-1` as ArtifactId, chain_id: `${output_name}-1` as ArtifactId,
  run_id: "run-1" as ArtifactRevision["run_id"], stage_instance_id: "stage-1" as ArtifactRevision["stage_instance_id"],
  execution_id: "stage-1:0" as ArtifactRevision["execution_id"], unit_id: "0" as UnitId, output_name,
  artifact_type: "dev.plan" as ArtifactRevision["artifact_type"], label: null, body: {}, version: 1,
  parent_artifact_id: null, lifecycle: { kind: "current" }, created_at: "2026-08-17T20:15:22Z",
});

const gateOutput: CompiledOutputContract = {
  name: "plan", artifact_type: "dev.plan" as CompiledOutputContract["artifact_type"],
  release: { kind: "gate", steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" }] }], requires_zero_open_review_items: false, revision_target: "self_stage" },
};
const expected = [{ unit_id: "0" as UnitId, output_name: "plan", artifact_type: "dev.plan" }];
const parked: readonly ArtifactReleaseState[] = [{ kind: "waiting_gate", artifact: artifact("plan"), gate_steps: gateOutput.release.kind === "gate" ? gateOutput.release.steps : [] }];

const contractFor = (releases: readonly ArtifactReleaseState[]) =>
  evaluateExecutionArtifactContract(releases, expected);

test("an artifact parked at a gate keeps the execution waiting after its agent exits", () => {
  const contract = contractFor(parked);
  expect(contract.kind).toBe("waiting_artifacts");
  // The exact shape that lost run 13931230's plan: the session closed while the
  // gate was still open, so the observation is a cancellation, not a success.
  expect(shouldAwaitArtifactRelease(contract, { kind: "cancelled", detail: "kbbl session was closed" }, parked)).toBe(true);
  expect(shouldAwaitArtifactRelease(contract, { kind: "failed", code: "executor_exit_nonzero", detail: "exit 1" }, parked)).toBe(true);
});

test("an output nothing ever emitted does not keep the execution waiting", () => {
  const contract = contractFor([]);
  expect(contract.kind).toBe("waiting_artifacts");
  expect(shouldAwaitArtifactRelease(contract, { kind: "cancelled", detail: "kbbl session was closed" }, [])).toBe(false);
});

test("a live agent still keeps the execution waiting whatever the release state", () => {
  expect(shouldAwaitArtifactRelease(contractFor([]), { kind: "succeeded", metadata: {} }, [])).toBe(true);
});

test("a satisfied contract never waits", () => {
  const released: readonly ArtifactReleaseState[] = [{ kind: "released", artifact: artifact("plan") }];
  const contract = contractFor(released);
  expect(contract.kind).toBe("satisfied");
  expect(shouldAwaitArtifactRelease(contract, { kind: "succeeded", metadata: {} }, released)).toBe(false);
});

test("a partially released collection does not wait on the outputs that were never emitted", () => {
  const twoExpected = [...expected, { unit_id: "0" as UnitId, output_name: "notes", artifact_type: "dev.plan" }];
  const contract = evaluateExecutionArtifactContract(parked, twoExpected);
  expect(shouldAwaitArtifactRelease(contract, { kind: "cancelled", detail: "closed" }, parked)).toBe(false);
});

/**
 * Contract evaluation used to key `missing_outputs` two different ways — by
 * `unit:output` when given an expected list, by bare output name when not — so
 * a caller comparing against the wrong space matched nothing and silently did
 * the opposite of what it intended. `shouldAwaitArtifactRelease` was that
 * caller. One key space now, produced and consumed by the same builder.
 */
test("what a contract reports missing is keyed the same way the waiting check reads it", () => {
  const contract = contractFor(parked);
  expect(contract.kind).toBe("waiting_artifacts");
  if (contract.kind !== "waiting_artifacts") return;
  expect(contract.missing_outputs).toEqual(["0:plan"]);
  // The key the waiting check builds from a parked release must be that string.
  expect(shouldAwaitArtifactRelease(contract, { kind: "cancelled", detail: "closed" }, parked)).toBe(true);
});

import { expect, test } from "bun:test";
import type { ArtifactRevision } from "../src/domain/artifacts";
import type { GateDecisionAudit } from "../src/domain/gates";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { createArtifactDetailApp } from "../src/http/artifact-detail";

const revision = (id: string, version: number): ArtifactRevision => ({ id: id as ArtifactId, chain_id: "artifact-1" as ArtifactId, run_id: "run-1" as WorkflowRunId, stage_instance_id: "stage-1" as StageInstanceId, execution_id: "execution-1" as ExecutionId, unit_id: "unit-1" as UnitId, output_name: "result", artifact_type: "dev.result", label: "web", body: { version }, version, parent_artifact_id: version === 1 ? null : `artifact-${version - 1}` as ArtifactId, lifecycle: version === 1 ? { kind: "superseded", superseded_by_artifact_id: "artifact-2" as ArtifactId } : { kind: "current" }, created_at: `2026-08-14T0${version}:00:00Z` });
const first = revision("artifact-1", 1); const second = revision("artifact-2", 2);

test("artifact detail derives revision status from applied gate decisions", async () => {
  const decision = { action: "approve" } as GateDecisionAudit;
  const app = createArtifactDetailApp({
    artifacts: { emit_revision: async () => ({ ok: true, value: { kind: "unchanged", artifact: second, superseded_artifact_id: null } }), withdraw: async () => ({ kind: "not_found", artifact_id: second.id }), mark_released: async () => ({ kind: "released", artifact: second }), find_by_id: async () => second, find_tip: async () => second, find_current: async () => second, list_chain: async () => [first, second] },
    stages: { start: async () => { throw new Error("unused"); }, finish: async () => { throw new Error("unused"); }, find_by_id: async () => ({ id: "stage-1" as StageInstanceId, run_id: "run-1" as WorkflowRunId, stage_key: "build", stage_type: "delegated_session", lifecycle: { kind: "started", started_at: first.created_at } }) },
    audits: { insert_idempotent: async (audit) => audit.id, mark_applied: async () => {}, find_by_idempotency_key: async () => null, find_for_revision: async (id) => id === second.id ? decision : null },
    presentation_for_type: () => ({ component_id: "build-result", capabilities: { reviewable: true, commentable: true, atom_editable: true, review_items: true }, anchor_schema: ["/summary"], review: { viewer: "build" } }),
  });
  const response = await app.request("/artifact_details/artifact-2");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({ id: "artifact-2", requested_revision_id: "artifact-2", current_revision_id: "artifact-2", producing_stage: "build", revisions: [expect.objectContaining({ id: "artifact-1", status: "draft", lifecycle: "superseded" }), expect.objectContaining({ id: "artifact-2", status: "approved", lifecycle: "current" })] }));
});

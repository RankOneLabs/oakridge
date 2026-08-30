import { expect, test } from "bun:test";
import type { ArtifactRevision } from "../src/domain/artifacts";
import type { GateDecisionAudit } from "../src/domain/gates";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { createArtifactDetailApp } from "../src/http/artifact-detail";

const revision = (id: string, version: number): ArtifactRevision => ({ id: id as ArtifactId, chain_id: "11111111-1111-4111-8111-111111111111" as ArtifactId, run_id: "22222222-2222-4222-8222-222222222222" as WorkflowRunId, stage_instance_id: "33333333-3333-4333-8333-333333333333" as StageInstanceId, execution_id: "execution-1" as ExecutionId, unit_id: "unit-1" as UnitId, output_name: "result", artifact_type: "dev.result", label: "web", body: { version }, version, parent_artifact_id: version === 1 ? null : `artifact-${version - 1}` as ArtifactId, lifecycle: version === 1 ? { kind: "superseded", superseded_by_artifact_id: "44444444-4444-4444-8444-444444444444" as ArtifactId } : { kind: "current" }, created_at: `2026-08-14T0${version}:00:00Z` });
const first = revision("11111111-1111-4111-8111-111111111111", 1); const second = revision("44444444-4444-4444-8444-444444444444", 2);

test("artifact detail derives revision status from applied gate decisions", async () => {
  const decision = { action: "approve" } as GateDecisionAudit;
  const app = createArtifactDetailApp({
    artifacts: { find_by_id: async () => second, find_current: async () => second, list_chain: async () => [first, second] },
    stages: { find_by_id: async () => ({ id: "33333333-3333-4333-8333-333333333333" as StageInstanceId, run_id: "22222222-2222-4222-8222-222222222222" as WorkflowRunId, stage_key: "build", stage_type: "delegated_session", lifecycle: { kind: "started", started_at: first.created_at } }) },
    audits: { insert_idempotent: async (audit) => audit.id, mark_applied: async () => {}, find_by_idempotency_key: async () => null, find_for_revision: async (id) => id === second.id ? decision : null },
    presentation_for_type: () => ({ component_id: "build-result", capabilities: { reviewable: true, commentable: true, atom_editable: true, review_items: true }, anchor_schema: ["/summary"], review: { viewer: "build" } }),
  });
  const response = await app.request("/artifact_details/44444444-4444-4444-8444-444444444444");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({ id: "44444444-4444-4444-8444-444444444444", requested_revision_id: "44444444-4444-4444-8444-444444444444", current_revision_id: "44444444-4444-4444-8444-444444444444", producing_stage: "build", revisions: [expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111", status: "draft", lifecycle: "superseded" }), expect.objectContaining({ id: "44444444-4444-4444-8444-444444444444", status: "approved", lifecycle: "current" })] }));
});

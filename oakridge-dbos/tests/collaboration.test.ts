import { expect, test } from "bun:test";

import type { ArtifactRevision } from "../src/domain/artifacts";
import type { CollaborationMessage, CollaborationThread, CollaborationThreadWithMessages, ReviewItem } from "../src/domain/collaboration";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { createCollaborationApp } from "../src/http/collaboration";
import type { CollaborationRepository } from "../src/storage/repositories";

const artifact: ArtifactRevision = { id: "artifact-2" as ArtifactId, chain_id: "artifact-1" as ArtifactId, run_id: "run-1" as WorkflowRunId, stage_instance_id: "stage-1" as StageInstanceId, execution_id: "execution-1" as ExecutionId, unit_id: "unit-1" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: {}, version: 2, parent_artifact_id: "artifact-1" as ArtifactId, created_at: "2026-08-14T12:00:00Z" };

const fixture = () => {
  const threads: CollaborationThread[] = []; const messages: CollaborationMessage[] = []; const items: ReviewItem[] = [];
  let emitted: ArtifactRevision | null = null;
  let sequence = 0;
  const repository: CollaborationRepository = {
    insert_thread_with_message: async (thread, message) => { threads.push(thread); messages.push(message); return { thread_id: thread.id, message_id: message.id }; },
    insert_thread: async (thread) => { threads.push(thread); return thread.id; }, insert_message: async (message) => { messages.push(message); return message.id; }, insert_review_item: async (item) => { items.push(item); return item.id; },
    find_thread: async (id) => threads.find((thread) => thread.id === id) ?? null,
    list_threads: async (chain) => threads.filter((thread) => thread.revision_id === chain).map((thread): CollaborationThreadWithMessages => ({ ...thread, messages: messages.filter((message) => message.thread_id === thread.id) })),
    update_thread_status: async (id, status) => { const index = threads.findIndex((thread) => thread.id === id); if (index >= 0) threads[index] = { ...threads[index]!, status }; },
    find_review_item: async (id) => items.find((item) => item.id === id) ?? null, list_review_items: async (chain) => items.filter((item) => item.revision_id === chain),
    update_review_item: async (id, status, resolution) => { const index = items.findIndex((item) => item.id === id); if (index >= 0) items[index] = { ...items[index]!, status, resolution }; },
    count_open_review_items: async (revision) => items.filter((item) => item.revision_id === revision && item.status === "open").length,
  };
  const contexts = { find_for_emit: async () => ({ run_id: artifact.run_id, stage_key: "review", operator_role: null, stage_instance_id: artifact.stage_instance_id, execution_id: artifact.execution_id, unit_id: artifact.unit_id, executor_type: "delegated_session", execution_workflow_id: "execution-workflow", inputs: [], outputs: [{ name: "result", artifact_type: "dev.result", release: { kind: "gate" as const, steps: [{ type: "artifact_approval", actions: ["approve"] }], requires_zero_open_review_items: false, revision_target: "self_stage" as const } }] }) };
  const app = createCollaborationApp({ artifacts: { emit_revision: async (id, emission, created_at) => emitted = { ...artifact, ...emission, id, chain_id: artifact.chain_id, version: 3, parent_artifact_id: artifact.id, created_at }, find_by_id: async () => artifact, find_tip: async () => artifact, list_chain: async () => [artifact] }, contexts, collaboration: repository, policy_for_artifact_type: () => ({ commentable: true, review_items: true, atom_editable: true, anchor_schema: ["/summary"] }), notify_artifact_revision: async () => {}, now: () => "2026-08-14T12:30:00Z", new_id: () => `id-${++sequence}` });
  return { app, repository, threads, messages, items, emitted: () => emitted };
};

test("thread creation atomically creates its first message against the artifact chain", async () => {
  const subject = fixture();
  const response = await subject.app.request("/artifacts/artifact-2/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "/summary", body: "Check this", author: "operator" }) });
  expect(response.status).toBe(201);
  expect(subject.threads[0]).toEqual(expect.objectContaining({ artifact_id: "artifact-2", revision_id: "artifact-1", anchor: "/summary" }));
  expect(subject.messages[0]).toEqual(expect.objectContaining({ thread_id: "id-1", body: "Check this" }));
});

test("resolved threads reject new messages", async () => {
  const subject = fixture();
  await subject.app.request("/artifacts/artifact-2/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "First", author: "operator" }) });
  await subject.app.request("/threads/id-1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "resolved" }) });
  const response = await subject.app.request("/threads/id-1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Late", author: "agent" }) });
  expect(response.status).toBe(400);
});

test("review items stay attached to the chain and can be resolved", async () => {
  const subject = fixture();
  const created = await subject.app.request("/artifacts/artifact-2/review_items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "/tests", claim: "Tests pass", reality: "One fails" }) });
  expect(created.status).toBe(201);
  const patched = await subject.app.request("/review_items/id-1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "resolved", resolution: "Fixed" }) });
  expect(await patched.json()).toEqual(expect.objectContaining({ revision_id: "artifact-1", status: "resolved", resolution: "Fixed" }));
});

test("artifact capability policy rejects unsupported collaboration", async () => {
  const subject = fixture();
  const app = createCollaborationApp({ artifacts: { emit_revision: async () => artifact, find_by_id: async () => artifact, find_tip: async () => artifact, list_chain: async () => [artifact] }, contexts: { find_for_emit: async () => null }, collaboration: subject.repository, policy_for_artifact_type: () => ({ commentable: false, review_items: false }), notify_artifact_revision: async () => {} });
  const response = await app.request("/artifacts/artifact-2/threads");
  expect(response.status).toBe(400);
});

test("atom edit uses optimistic concurrency and creates a parent-linked revision", async () => {
  const subject = fixture();
  const editableArtifact = { ...artifact, body: { summary: "before" } };
  const notifications: unknown[] = [];
  const app = createCollaborationApp({
    artifacts: { emit_revision: async (id, emission, created_at) => ({ ...editableArtifact, ...emission, id, chain_id: artifact.chain_id, version: 3, parent_artifact_id: artifact.id, created_at }), find_by_id: async () => editableArtifact, find_tip: async () => editableArtifact, list_chain: async () => [editableArtifact] },
    contexts: { find_for_emit: async () => ({ run_id: artifact.run_id, stage_key: "review", operator_role: null, stage_instance_id: artifact.stage_instance_id, execution_id: artifact.execution_id, unit_id: artifact.unit_id, executor_type: "delegated_session", execution_workflow_id: "execution-workflow", inputs: [], outputs: [{ name: "result", artifact_type: "dev.result", release: { kind: "gate", steps: [{ type: "artifact_approval", actions: ["approve"] }], requires_zero_open_review_items: false, revision_target: "self_stage" } }] }) },
    collaboration: subject.repository, policy_for_artifact_type: () => ({ commentable: true, review_items: true, atom_editable: true, anchor_schema: ["/summary"] }), notify_artifact_revision: async (workflow, revision, release) => { notifications.push({ workflow, revision, release }); }, new_id: () => "artifact-3", now: () => "2026-08-14T13:00:00Z",
  });
  const response = await app.request("/artifacts/artifact-2/edits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "/summary", prev_value: "before", new_value: "after", author: "operator" }) });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ artifact_id: "artifact-3" });
  expect(notifications).toEqual([expect.objectContaining({ workflow: "execution-workflow", release: expect.objectContaining({ kind: "waiting_gate" }) })]);
});

test("atom edit rejects a stale previous value", async () => {
  const subject = fixture();
  const response = await subject.app.request("/artifacts/artifact-2/edits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "/summary", prev_value: "wrong", new_value: "after", author: "operator" }) });
  expect(response.status).toBe(409);
  expect(subject.emitted()).toBeNull();
});

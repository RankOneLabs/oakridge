import { expect, test } from "bun:test";

import type { ArtifactRevision } from "../src/domain/artifacts";
import type { CollaborationMessage, CollaborationThread, CollaborationThreadWithMessages, DeliverSessionMessage, ReviewItem, SessionMessageEnqueueResult, SessionMessageRecord } from "../src/domain/collaboration";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import { createCollaborationApp, type CollaborationHttpDependencies } from "../src/http/collaboration";
import type { CollaborationRepository } from "../src/storage/repositories";

const WORK_ORDER_ID = "66666666-6666-4666-8666-666666666666" as WorkOrderId;
const artifact: ArtifactRevision = { id: "11111111-1111-4111-8111-111111111111" as ArtifactId, chain_id: "22222222-2222-4222-8222-222222222222" as ArtifactId, run_id: "33333333-3333-4333-8333-333333333333" as WorkflowRunId, stage_instance_id: "44444444-4444-4444-8444-444444444444" as StageInstanceId, execution_id: WORK_ORDER_ID as unknown as ExecutionId, unit_id: "unit-1" as UnitId, output_name: "result", artifact_type: "dev.result", label: null, body: {}, version: 2, parent_artifact_id: "22222222-2222-4222-8222-222222222222" as ArtifactId, lifecycle: { kind: "current" }, created_at: "2026-08-14T12:00:00Z" };
/** The v2 executor attachment `find_work_order_attachment` returns for the work order the fixture's `artifact` was published under. */
const attachment = { work_order_id: WORK_ORDER_ID, executor_type: "delegated_session", external_reference: { kind: "kbbl_session" as const, session_id: "session-1" }, health: null, cleanup_state: "not_needed" as const, updated_at: "2026-08-14T12:00:00Z" };
const neverCalled = (name: string) => async () => { throw new Error(`${name} must not be called`); };
/** A `records` dependency stub for tests that never reach a work-order lookup. */
const unusedRecords: CollaborationHttpDependencies["records"] = { find_work_order_attachment: neverCalled("find_work_order_attachment") };

const fixture = (forceConflict = false, recipientFailure = false) => {
  const threads: CollaborationThread[] = []; const messages: CollaborationMessage[] = []; const items: ReviewItem[] = []; const sessionMessages: SessionMessageRecord[] = [];
  let sequence = 0;
  const repository: CollaborationRepository = {
    insert_thread_with_message: async (thread, message) => { threads.push(thread); messages.push(message); return { thread_id: thread.id, message_id: message.id }; },
    insert_thread: async (thread) => { threads.push(thread); return thread.id; }, insert_message: async (message) => { messages.push(message); return message.id; }, insert_review_item: async (item) => { items.push(item); return item.id; },
    find_thread: async (id) => threads.find((thread) => thread.id === id) ?? null,
    list_threads: async (chain) => threads.filter((thread) => thread.artifact_id === chain).map((thread): CollaborationThreadWithMessages => ({ ...thread, messages: messages.filter((message) => message.thread_id === thread.id) })),
    update_thread_status: async (id, status) => { const index = threads.findIndex((thread) => thread.id === id); if (index >= 0) threads[index] = { ...threads[index]!, status }; },
    find_review_item: async (id) => items.find((item) => item.id === id) ?? null, list_review_items: async (chain) => items.filter((item) => item.revision_id === chain),
    update_review_item: async (id, status, resolution) => { const index = items.findIndex((item) => item.id === id); if (index >= 0) items[index] = { ...items[index]!, status, resolution }; },
    count_open_review_items: async (revision) => items.filter((item) => item.revision_id === revision && item.status === "open").length,
  };
  const persistMessage = async (input: DeliverSessionMessage): Promise<SessionMessageEnqueueResult> => {
    const { message } = input;
    if (forceConflict) return { kind: "idempotency_conflict", detail: "message identity is already in use" };
    const existing = sessionMessages.find((candidate) => candidate.run_id === message.run_id && candidate.delivery_key === message.delivery_key);
    const identity = sessionMessages.find((candidate) => candidate.run_id === message.run_id && candidate.thread_id === message.thread_id && candidate.message_id === message.message_id);
    if (!existing && identity) return { kind: "idempotency_conflict", detail: "message identity is already in use" };
    const record: SessionMessageRecord = existing ?? { ...message, sender_kind: message.sender.kind, sender_id: message.sender.id, recipient_kind: message.recipient.kind, recipient_id: message.recipient.id, delivery_status: "pending", delivery_result: null, delivered_at: null };
    if (!existing) sessionMessages.push(record);
    return { kind: "accepted" as const, message: record, workflow_id: `message:${message.run_id}:${message.delivery_key}` };
  };
  const deliveryRequests: DeliverSessionMessage[] = [];
  const deliver = async (input: DeliverSessionMessage) => { deliveryRequests.push(input); return persistMessage(input); };
  const app = createCollaborationApp({
    artifacts: { find_by_id: async () => artifact, find_current: async () => artifact, list_chain: async () => [artifact] },
    collaboration: repository,
    records: { find_work_order_attachment: async () => attachment },
    messages: {
      find_by_delivery_key: async (runId, key) => sessionMessages.find((message) => message.run_id === runId && message.delivery_key === key) ?? null,
      list_for_run: async (runId, cohortId) => sessionMessages.filter((message) => message.run_id === runId && (cohortId === undefined || message.cohort_id === cohortId)),
    },
    message_recipients: { resolve: async () => recipientFailure
      ? { kind: "recipient_not_deliverable", detail: "recipient session is unavailable" }
      : { kind: "resolved", target: { execution_id: artifact.execution_id, executor_type: attachment.executor_type, external_reference: attachment.external_reference } } },
    send_message: deliver,
    ping_thread: deliver,
    policy_for_artifact_type: () => ({ commentable: true, review_items: true, atom_editable: true }),
    now: () => "2026-08-14T12:30:00Z", new_id: () => `${String(++sequence).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` });
  return { app, repository, threads, messages, items, sessionMessages, deliveryRequests };
};

test("thread creation atomically creates its first message against the artifact chain", async () => {
  const subject = fixture();
  const response = await subject.app.request("/artifacts/11111111-1111-4111-8111-111111111111/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "/summary", body: "Check this", author: "operator" }) });
  expect(response.status).toBe(201);
  expect(subject.threads[0]).toEqual(expect.objectContaining({ artifact_id: "22222222-2222-4222-8222-222222222222", revision_id: "11111111-1111-4111-8111-111111111111", anchor: "/summary" }));
  expect(subject.messages[0]).toEqual(expect.objectContaining({ thread_id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", body: "Check this" }));
});

test("resolved threads reject new messages", async () => {
  const subject = fixture();
  await subject.app.request("/artifacts/11111111-1111-4111-8111-111111111111/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "First", author: "operator" }) });
  await subject.app.request("/threads/11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "resolved" }) });
  const response = await subject.app.request("/threads/11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Late", author: "agent" }) });
  expect(response.status).toBe(400);
});

test("ping durably targets the attached executor using the latest thread message", async () => {
  const subject = fixture();
  await subject.app.request("/artifacts/11111111-1111-4111-8111-111111111111/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "/summary", body: "Please explain", author: "operator" }) });
  const response = await subject.app.request("/threads/11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa/ping", { method: "POST", headers: { "idempotency-key": "ping-request-1" } });
  expect(response.status).toBe(202);
  expect(subject.deliveryRequests[0]).toEqual(expect.objectContaining({
    message: expect.objectContaining({ run_id: artifact.run_id, artifact_thread_id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", delivery_key: "ping-request-1" }),
    target: { execution_id: artifact.execution_id, executor_type: "delegated_session", external_reference: { kind: "kbbl_session", session_id: "session-1" } },
    prompt: expect.stringContaining("operator: Please explain"),
  }));
});

test("run messages need no artifact thread and are readable from their cohort view", async () => {
  const subject = fixture();
  const runId = "33333333-3333-4333-8333-333333333333";
  const cohortId = "55555555-5555-4555-8555-555555555555";
  const response = await subject.app.request(`/runs/${runId}/messages`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "cross-stage-1" },
    body: JSON.stringify({ cohort_id: cohortId, sender: { kind: "agent", id: "builder" }, recipient: { kind: "agent", id: "reviewer" }, thread_id: "build-review", message_id: "message-1", body: { text: "Please review" } }),
  });
  expect(response.status).toBe(202);
  expect(subject.sessionMessages[0]).toEqual(expect.objectContaining({ run_id: runId, cohort_id: cohortId, artifact_thread_id: null, sender_kind: "agent", sender_id: "builder", recipient_kind: "agent", recipient_id: "reviewer", delivery_key: "cross-stage-1" }));
  expect(subject.deliveryRequests[0]).toEqual(expect.objectContaining({
    message: expect.objectContaining({ run_id: runId, recipient: { kind: "agent", id: "reviewer" } }),
    target: { execution_id: artifact.execution_id, executor_type: "delegated_session", external_reference: { kind: "kbbl_session", session_id: "session-1" } },
    prompt: JSON.stringify({ text: "Please review" }),
  }));
  const listed = await subject.app.request(`/runs/${runId}/messages?cohort_id=${cohortId}`);
  expect(await listed.json()).toEqual([expect.objectContaining({ message_id: "message-1", cohort_id: cohortId })]);
  const found = await subject.app.request(`/runs/${runId}/messages/cross-stage-1`);
  expect(await found.json()).toEqual(expect.objectContaining({ delivery_status: "pending", delivery_result: null }));
});

test("a repeated message identity with a new durable key returns a typed conflict", async () => {
  const subject = fixture();
  const url = "/runs/33333333-3333-4333-8333-333333333333/messages";
  const body = JSON.stringify({ sender: { kind: "agent", id: "builder" }, recipient: { kind: "agent", id: "reviewer" }, thread_id: "build-review", message_id: "message-1", body: "Review" });
  expect((await subject.app.request(url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "delivery-1" }, body })).status).toBe(202);
  const response = await subject.app.request(url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "delivery-2" }, body });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "message identity is already in use", code: "idempotency_conflict" });
});

test("a run message returns a typed conflict when its recipient cannot be delivered", async () => {
  const subject = fixture(false, true);
  const response = await subject.app.request("/runs/33333333-3333-4333-8333-333333333333/messages", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "delivery-1" },
    body: JSON.stringify({ sender: { kind: "agent", id: "builder" }, recipient: { kind: "agent", id: "missing" }, thread_id: "build-review", body: "Review" }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "recipient session is unavailable", code: "recipient_not_deliverable" });
  expect(subject.deliveryRequests).toEqual([]);
});

test("a modeled ping conflict returns 409", async () => {
  const subject = fixture(true);
  await subject.app.request("/artifacts/11111111-1111-4111-8111-111111111111/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Please explain", author: "operator" }) });
  const response = await subject.app.request("/threads/11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa/ping", { method: "POST", headers: { "idempotency-key": "ping-request-1" } });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "message identity is already in use", code: "idempotency_conflict" });
});

test("ping rejects an unsafe durable request identity", async () => {
  const subject = fixture();
  await subject.app.request("/artifacts/11111111-1111-4111-8111-111111111111/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Please explain", author: "operator" }) });
  const response = await subject.app.request("/threads/11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa/ping", { method: "POST", headers: { "idempotency-key": "unsafe/request" } });
  expect(response.status).toBe(400);
  expect(subject.deliveryRequests).toEqual([]);
});

test("review items stay attached to the chain and can be resolved", async () => {
  const subject = fixture();
  const created = await subject.app.request("/artifacts/11111111-1111-4111-8111-111111111111/review_items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "/tests", claim: "Tests pass", reality: "One fails" }) });
  expect(created.status).toBe(201);
  const patched = await subject.app.request("/review_items/11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "resolved", resolution: "Fixed" }) });
  expect(await patched.json()).toEqual(expect.objectContaining({ revision_id: "11111111-1111-4111-8111-111111111111", status: "resolved", resolution: "Fixed" }));
});

test("artifact capability policy rejects unsupported collaboration", async () => {
  const subject = fixture();
  const app = createCollaborationApp({ artifacts: { find_by_id: async () => artifact, find_current: async () => artifact, list_chain: async () => [artifact] }, records: unusedRecords, collaboration: subject.repository, ping_thread: neverCalled("ping_thread"), policy_for_artifact_type: () => ({ commentable: false, review_items: false, atom_editable: false }) });
  const response = await app.request("/artifacts/11111111-1111-4111-8111-111111111111/threads");
  expect(response.status).toBe(400);
  const edit = await app.request("/artifacts/11111111-1111-4111-8111-111111111111/edits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "/summary", prev_value: "before", new_value: "after", author: "operator" }) });
  expect(edit.status).toBe(400);
});

test("atom edit on a current, editable artifact is refused as unsupported and touches no record", async () => {
  const subject = fixture();
  const app = createCollaborationApp({
    artifacts: { find_by_id: async () => artifact, find_current: async () => artifact, list_chain: async () => [artifact] },
    records: unusedRecords,
    ping_thread: neverCalled("ping_thread"),
    collaboration: subject.repository, policy_for_artifact_type: () => ({ commentable: true, review_items: true, atom_editable: true }),
  });
  const response = await app.request("/artifacts/11111111-1111-4111-8111-111111111111/edits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "/summary", prev_value: "before", new_value: "after", author: "operator" }) });
  expect(response.status).toBe(501);
  const body = await response.json() as { readonly error: string; readonly code: string };
  expect(body).toEqual({ error: expect.any(String), code: "revision_unsupported" });
  expect(body.error).toContain("revision");
});

test("collaboration mutations reject a superseded artifact revision", async () => {
  const subject = fixture();
  const stale = { ...artifact, lifecycle: { kind: "superseded" as const, superseded_by_artifact_id: "55555555-5555-4555-8555-555555555555" as ArtifactId } };
  const app = createCollaborationApp({ artifacts: { find_by_id: async () => stale, find_current: async () => null, list_chain: async () => [stale] }, records: unusedRecords, collaboration: subject.repository, ping_thread: neverCalled("ping_thread"), policy_for_artifact_type: () => ({ commentable: true, review_items: true, atom_editable: true }) });
  const edit = await app.request("/artifacts/11111111-1111-4111-8111-111111111111/edits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "/summary", prev_value: "before", new_value: "after", author: "operator" }) });
  expect(edit.status).toBe(409);
  expect(await edit.json()).toEqual({ error: "artifact revision is not current", code: "superseded" });
  const thread = await app.request("/artifacts/11111111-1111-4111-8111-111111111111/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "stale", author: "operator" }) });
  const item = await app.request("/artifacts/11111111-1111-4111-8111-111111111111/review_items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "/summary", claim: "old", reality: "stale" }) });
  expect([thread.status, item.status]).toEqual([409, 409]);
  expect((await app.request("/artifacts/11111111-1111-4111-8111-111111111111/threads")).status).toBe(200);
  expect((await app.request("/artifacts/11111111-1111-4111-8111-111111111111/review_items")).status).toBe(200);
});

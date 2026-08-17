import { expect, test } from "bun:test";

import type { ArtifactLifecycleNotification, ArtifactRevision, PendingArtifactNotification } from "../src/domain/artifacts";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { dispatchArtifactNotifications } from "../src/runtime/artifact-notifications";
import type { ArtifactNotificationRepository } from "../src/storage/repositories";

const pending = (id: string, message: ArtifactLifecycleNotification): PendingArtifactNotification => ({
  id, target_workflow_id: "execution-workflow", message, idempotency_key: `notification:${id}`,
});

const revision = (id: ArtifactId): ArtifactRevision => ({
  id, chain_id: id, run_id: "run-1" as WorkflowRunId, stage_instance_id: "stage-1" as StageInstanceId,
  execution_id: "execution-1" as ExecutionId, unit_id: "unit-1" as UnitId, output_name: "result",
  artifact_type: "dev.result", label: null, body: {}, version: 1, parent_artifact_id: null,
  lifecycle: { kind: "current" }, created_at: "2026-08-15T00:00:00Z",
});

const repositoryWith = (notifications: readonly PendingArtifactNotification[], delivered: string[], failed: string[] = []): ArtifactNotificationRepository => ({
  claim_pending_notifications: async () => delivered.length === 0 && failed.length === 0 ? notifications : [],
  mark_notification_delivered: async (id) => { delivered.push(id); },
  mark_notification_failed: async (id) => { failed.push(id); },
});

test("outbox dispatcher delivers replacement as one atomic workflow command", async () => {
  const oldId = "artifact-1" as ArtifactId; const nextId = "artifact-2" as ArtifactId;
  const notifications = [
    pending("replace", { kind: "artifact_replaced", invalidated_artifact_id: oldId, release: { kind: "waiting_gate", artifact: revision(nextId), gate_steps: [{ type: "artifact_approval", actions: [{ name: "approve", disposition: "release" as const }] }] } }),
  ];
  const delivered: string[] = []; const sent: string[] = [];
  const count = await dispatchArtifactNotifications(repositoryWith(notifications, delivered), { send: async (_workflow, message) => { sent.push(message.kind); } }, () => "2026-08-15T00:00:00Z");
  expect(count).toBe(1);
  expect(sent).toEqual(["artifact_replaced"]);
  expect(delivered).toEqual(["replace"]);
});

test("outbox dispatcher releases a failed claim for restart recovery", async () => {
  const notification = pending("close-old", { kind: "artifact_invalidated", artifact_id: "artifact-1" as ArtifactId, output_name: "result", reason: "withdrawn", replacement_artifact_revision_id: null });
  const delivered: string[] = []; const failed: string[] = [];
  expect(await dispatchArtifactNotifications(repositoryWith([notification], delivered, failed), { send: async () => { throw new Error("transport unavailable"); } })).toBe(0);
  expect(delivered).toEqual([]);
  expect(failed).toEqual(["close-old"]);
});

test("one unreachable workflow does not block another workflow notification", async () => {
  const first = pending("poison", { kind: "artifact_invalidated", artifact_id: "artifact-1" as ArtifactId, output_name: "result", reason: "withdrawn", replacement_artifact_revision_id: null });
  const second = { ...pending("healthy", { kind: "artifact_invalidated", artifact_id: "artifact-2" as ArtifactId, output_name: "result", reason: "withdrawn", replacement_artifact_revision_id: null }), target_workflow_id: "other-workflow" };
  const delivered: string[] = []; const failed: string[] = [];
  const count = await dispatchArtifactNotifications(repositoryWith([first, second], delivered, failed), { send: async (workflow) => { if (workflow === "execution-workflow") throw new Error("poison"); } });
  expect(count).toBe(1);
  expect(failed).toEqual(["poison"]);
  expect(delivered).toEqual(["healthy"]);
});

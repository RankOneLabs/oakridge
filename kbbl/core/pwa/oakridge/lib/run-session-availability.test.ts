import { afterEach, beforeEach, expect, it } from "vitest";

import { useStore } from "../../state/store";
import type { Sid } from "../../lib/ids";
import type { SessionSnapshot } from "../../types";
import type { RunDetail } from "../types";
import { selectPurgedRunSessionIds, type RunSessionsRead } from "./run-sessions";
import { resolveWorkspaceState } from "./run-workspace-restore";
import type { RunWorkspaceState } from "./run-workspace";

const legacy: SessionSnapshot = {
  sid: "legacy", name: "Archived attempt", agentProfile: "codex", status: "idle",
  source: "legacy_archive", lastActivityTs: "2026-09-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z",
  artifactId: null, projectWorkdir: "/repo", worktreePath: "/repo",
  worktreeBranch: null, worktreeBaseRef: null, requestedModel: null,
  requestedEffort: null, endReason: null, fencedBy: null, pendingPermissionCount: 0, workflow: null,
};
const run: RunDetail = {
  id: "run", title: "Archive inventory", repository_keys: [],
  workflow_name: "dev_flow_v2", status: "blocked", blocked_reason: "gate", next_actor: "operator",
  parked_count: 0, updated_at: "2026-09-01T00:00:00Z", stages: [],
};
const sessions: RunSessionsRead = {
  kind: "loaded",
  sessions: ["legacy", "deleted"].map((session_id) => ({
    work_order_id: session_id, session_id, stage_instance_id: "stage",
    stage_key: "build", unit_id: "unit", reason: "initial",
    work_order_state: "completed", created_at: "2026-09-01T00:00:00Z",
    completed_at: null, executor_health_kind: null, cleanup_state: "complete",
  })) as never,
};
const storedState: RunWorkspaceState = {
  primary: { kind: "session", session_id: "legacy" as Sid }, secondary: null,
};
const purgedIds = () => selectPurgedRunSessionIds({ run, sessions, inventory: useStore.getState() });
const restored = () => resolveWorkspaceState({
  run, sessions, storedState, routePane: null, purgedSessionIds: purgedIds(),
});

beforeEach(() => useStore.setState(useStore.getInitialState()));
afterEach(() => useStore.setState(useStore.getInitialState()));

it("preserves the saved legacy pane until a delayed archive seed arrives", () => {
  useStore.getState().applySnapshot([]);
  expect(restored().should_prune_stored).toBe(false);
  expect(restored().state).toEqual(storedState);
  useStore.getState().seedSessions([legacy]);
  expect(restored().should_prune_stored).toBe(false);
  expect(restored().state).toEqual(storedState);
  expect(purgedIds()).toEqual(new Set(["deleted"]));
});

it("waits for the inbox when the archive seed arrives first", () => {
  useStore.getState().seedSessions([legacy]);
  expect(purgedIds()).toEqual(new Set());
  useStore.getState().applySnapshot([]);
  expect(purgedIds()).toEqual(new Set(["deleted"]));
});

it("accepts a successful empty archive inventory as authoritative", () => {
  useStore.getState().applySnapshot([]);
  useStore.getState().seedSessions([]);
  expect(purgedIds()).toEqual(new Set(["legacy", "deleted"]));
});

it("preserves unknown sessions while the archive request has not succeeded", () => {
  useStore.getState().applySnapshot([]);
  useStore.getState().applySnapshot([]);
  expect(purgedIds()).toEqual(new Set());
});

it("applies observed ACP deletions while the archive seed is pending", () => {
  useStore.getState().applySnapshot([{ ...legacy, sid: "deleted", source: "acp" }]);
  useStore.getState().applySnapshot([]);
  expect(purgedIds()).toEqual(new Set(["deleted"]));
});

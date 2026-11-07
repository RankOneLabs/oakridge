import { afterEach, beforeEach, expect, it } from "vitest";

import { useStore } from "../../state/store";
import type { Sid } from "../../lib/ids";
import type { SessionSnapshot } from "../../types";
import type { RunDetail } from "../run-types";
import { selectPurgedRunSessionIds, type RunSessionsRead } from "./run-sessions";
import { resolveWorkspaceState } from "./run-workspace-restore";
import type { RunWorkspaceState } from "./run-workspace";

const session: SessionSnapshot = {
  sid: "kept", name: "Ended attempt", agentProfile: "codex", status: "idle",
  source: "acp", lastActivityTs: "2026-09-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z",
  artifactId: null, projectWorkdir: "/repo", worktreePath: "/repo",
  worktreeBranch: null, worktreeBaseRef: null, requestedModel: null,
  requestedEffort: null, endReason: null, fencedBy: null,
  archivedAt: null, pendingPermissionCount: 0, workflow: null,
};
const run: RunDetail = {
  id: "run", title: "Session inventory", repository_keys: [],
  workflow_name: "dev_flow_v2", status: "parked", is_stuck: false,
  parked_count: 0, updated_at: "2026-09-01T00:00:00Z", stages: [],
};
const sessions: RunSessionsRead = {
  kind: "loaded",
  attempts: ["kept", "deleted"].map((session_id) => ({
    work_order_id: session_id, session_id, stage_instance_id: "stage",
    stage_key: "build", unit_id: "unit", reason: "initial",
    work_order_state: "completed", created_at: "2026-09-01T00:00:00Z",
    completed_at: null, executor_health_kind: null, cleanup_state: "complete",
  })),
};
const storedState: RunWorkspaceState = {
  primary: { kind: "session", session_id: "kept" as Sid }, secondary: null,
};
const purgedIds = () => selectPurgedRunSessionIds({ run, sessions, inventory: useStore.getState() });
const restored = () => resolveWorkspaceState({
  run, sessions, storedState, routePane: null, purgedSessionIds: purgedIds(),
});

beforeEach(() => useStore.setState(useStore.getInitialState()));
afterEach(() => useStore.setState(useStore.getInitialState()));

it("preserves a saved pane until the inbox snapshot arrives", () => {
  expect(restored().should_prune_stored).toBe(false);
  expect(purgedIds()).toEqual(new Set());
});

it("treats an attempt missing from the inventory as purged", () => {
  useStore.getState().applySnapshot([session]);
  expect(restored().state).toEqual(storedState);
  expect(purgedIds()).toEqual(new Set(["deleted"]));
});

it("accepts an empty inventory as authoritative", () => {
  useStore.getState().applySnapshot([]);
  expect(purgedIds()).toEqual(new Set(["kept", "deleted"]));
});

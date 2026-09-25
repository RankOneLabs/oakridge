import { describe, expect, it } from "vitest";

import type { ArtifactId, Sid } from "../../lib/ids";
import type { RunDetail, RunSessionAttempt } from "../types";
import type { RunSessionsRead } from "./run-sessions";
import {
  LIST_PANE,
  OVERVIEW_PANE,
  type RunWorkspacePane,
  type RunWorkspaceState,
} from "./run-workspace";
import {
  indexRunEntities,
  isPaneResolvable,
  resolveWorkspaceState,
  validateWorkspacePanes,
} from "./run-workspace-restore";

const sessionPane = (id: string): RunWorkspacePane => ({ kind: "session", session_id: id as Sid });
const artifactPane = (id: string): RunWorkspacePane => ({ kind: "artifact", artifact_id: id as ArtifactId });

const RUN: RunDetail = {
  id: "run-1",
  title: "Ship the run command center",
  repository_keys: ["oakridge"],
  workflow_name: "dev_flow_v2",
  status: "running",
  is_stuck: false,
  parked_count: 0,
  updated_at: "2026-09-01T10:00:00Z",
  stages: [
    {
      stage_instance_id: "si-plan",
      name: "plan",
      type: "delegated_session",
      status: "complete",
      artifacts: [{ id: "art-plan", type_id: "dev.plan", version: 1 }],
      delegated_kbbl_sid: "sid-plan",
      worktree: null,
    },
    {
      stage_instance_id: "si-build",
      name: "build",
      type: "delegated_session",
      status: "running",
      artifacts: [{ id: "art-build", type_id: "dev.build_result", version: 1 }],
      delegated_kbbl_sid: null,
      worktree: null,
      units: [
        { unit_id: "c1", sid: "sid-c1", worktree: null, status: "complete", gate: null },
        { unit_id: "c2", sid: "sid-c2", worktree: null, status: "running", gate: null },
      ],
    },
  ],
};

/**
 * `sid-c1-prior` is the one session only the attempt list knows about.
 *
 * A unit's `sid` on the run is its *current* attempt, so every other session id
 * here is reachable from the run read alone — which makes them useless for
 * telling whether the attempt list was consulted at all. A superseded attempt's
 * transcript exists only in this list, and a pane holding one is exactly what a
 * failed read must not quietly discard.
 */
const SESSIONS: readonly RunSessionAttempt[] = [
  {
    work_order_id: "wo-0",
    session_id: "sid-c1-prior",
    stage_instance_id: "si-build",
    stage_key: "build",
    unit_id: "c1",
    reason: "initial",
    work_order_state: "abandoned",
    created_at: "2026-09-01T08:00:00Z",
    completed_at: "2026-09-01T08:20:00Z",
    executor_health_kind: null,
    cleanup_state: "complete",
  },
  {
    work_order_id: "wo-1",
    session_id: "sid-c1",
    stage_instance_id: "si-build",
    stage_key: "build",
    unit_id: "c1",
    reason: "initial",
    work_order_state: "completed",
    created_at: "2026-09-01T09:00:00Z",
    completed_at: "2026-09-01T09:30:00Z",
    executor_health_kind: null,
    cleanup_state: "complete",
  },
  {
    work_order_id: "wo-2",
    session_id: "sid-c2",
    stage_instance_id: "si-build",
    stage_key: "build",
    unit_id: "c2",
    reason: "initial",
    work_order_state: "started",
    created_at: "2026-09-01T09:40:00Z",
    completed_at: null,
    executor_health_kind: null,
    cleanup_state: "pending",
  },
];

const resolve = (
  routePane: Parameters<typeof resolveWorkspaceState>[0]["routePane"],
  storedState: Parameters<typeof resolveWorkspaceState>[0]["storedState"],
) => resolveWorkspaceState({ routePane, storedState, run: RUN, sessions: LOADED_SESSIONS, purgedSessionIds: NO_PURGED_SESSIONS });

/** Nothing purged — the ordinary case, named so each call site says so. */
const NO_PURGED_SESSIONS: ReadonlySet<string> = new Set();

/** The attempt read having landed — the ordinary case for every test but its own. */
const LOADED_SESSIONS: RunSessionsRead = { kind: "loaded", attempts: SESSIONS };

describe("indexRunEntities", () => {
  it("indexes every session the run shows, from attempts and from stages alike", () => {
    const index = indexRunEntities({ run: RUN, sessions: LOADED_SESSIONS, purgedSessionIds: NO_PURGED_SESSIONS });

    expect(index.sessions).toEqual({
      kind: "known",
      ids: new Set(["sid-c1-prior", "sid-c1", "sid-c2", "sid-plan"]),
    });
    expect(index.artifact_ids).toEqual(new Set(["art-plan", "art-build"]));
  });

  it("knows nothing about sessions when the attempt read did not land", () => {
    const index = indexRunEntities({
      run: RUN,
      sessions: { kind: "unavailable" },
      purgedSessionIds: NO_PURGED_SESSIONS,
    });

    // The stage sids are still in hand, but they are not the run's whole
    // session list — reporting them as if they were is what lets validation
    // mistake an outage for a run whose sessions are gone.
    expect(index.sessions).toEqual({ kind: "unknown" });
    expect(index.artifact_ids).toEqual(new Set(["art-plan", "art-build"]));
  });
});

describe("a session purged out from under a pane", () => {
  const purged: ReadonlySet<string> = new Set(["sid-c1"]);

  it("stops resolving, even though the run still lists its work order", () => {
    const index = indexRunEntities({ run: RUN, sessions: LOADED_SESSIONS, purgedSessionIds: purged });

    expect(isPaneResolvable(sessionPane("sid-c1"), index)).toBe(false);
    expect(isPaneResolvable(sessionPane("sid-c2"), index)).toBe(true);
  });

  it("stays authoritative when the attempt read did not land", () => {
    const index = indexRunEntities({
      run: RUN,
      sessions: { kind: "unavailable" },
      purgedSessionIds: purged,
    });

    // An unknown session list is a reason not to judge, not a reason to forget
    // what the inbox positively reported gone.
    expect(isPaneResolvable(sessionPane("sid-c1"), index)).toBe(false);
    expect(isPaneResolvable(sessionPane("sid-c1-prior"), index)).toBe(true);
  });

  it("drops the pane holding it back to the overview", () => {
    const index = indexRunEntities({ run: RUN, sessions: LOADED_SESSIONS, purgedSessionIds: purged });

    const validated = validateWorkspacePanes(
      { primary: sessionPane("sid-c1"), secondary: LIST_PANE },
      index,
    );

    expect(validated.state.primary).toEqual(OVERVIEW_PANE);
    expect(validated.state.secondary).toEqual(LIST_PANE);
    expect(validated.dropped_a_pane).toBe(true);
  });

  it("closes a twin holding it and leaves the primary alone", () => {
    const index = indexRunEntities({ run: RUN, sessions: LOADED_SESSIONS, purgedSessionIds: purged });

    const validated = validateWorkspacePanes(
      { primary: LIST_PANE, secondary: sessionPane("sid-c1") },
      index,
    );

    expect(validated.state.primary).toEqual(LIST_PANE);
    expect(validated.state.secondary).toBeNull();
    expect(validated.dropped_a_pane).toBe(true);
  });

  it("reports nothing dropped when every pane still resolves", () => {
    const index = indexRunEntities({ run: RUN, sessions: LOADED_SESSIONS, purgedSessionIds: purged });

    const validated = validateWorkspacePanes(
      { primary: sessionPane("sid-c2"), secondary: null },
      index,
    );

    expect(validated.state.primary).toEqual(sessionPane("sid-c2"));
    expect(validated.dropped_a_pane).toBe(false);
  });
});

describe("isPaneResolvable", () => {
  it("always resolves the panes derived from the run itself", () => {
    const index = indexRunEntities({ run: RUN, sessions: LOADED_SESSIONS, purgedSessionIds: NO_PURGED_SESSIONS });

    expect(isPaneResolvable(OVERVIEW_PANE, index)).toBe(true);
    expect(isPaneResolvable(LIST_PANE, index)).toBe(true);
  });

  it("resolves an entity pane only when the run still contains it", () => {
    const index = indexRunEntities({ run: RUN, sessions: LOADED_SESSIONS, purgedSessionIds: NO_PURGED_SESSIONS });

    expect(isPaneResolvable(sessionPane("sid-c1"), index)).toBe(true);
    expect(isPaneResolvable(sessionPane("sid-purged"), index)).toBe(false);
    expect(isPaneResolvable(artifactPane("art-build"), index)).toBe(true);
    expect(isPaneResolvable(artifactPane("art-deleted"), index)).toBe(false);
  });
});

describe("route-vs-store precedence", () => {
  it("lets the store win for a bare run route", () => {
    const resolution = resolve(null, { primary: sessionPane("sid-c1"), secondary: LIST_PANE });

    expect(resolution.state).toEqual({ primary: sessionPane("sid-c1"), secondary: LIST_PANE });
    expect(resolution.should_prune_stored).toBe(false);
  });

  it("lets a route naming an artifact overwrite a conflicting stored primary", () => {
    const resolution = resolve(
      { kind: "artifact", artifact_id: "art-build" as ArtifactId },
      { primary: sessionPane("sid-c1"), secondary: null },
    );

    expect(resolution.state.primary).toEqual(artifactPane("art-build"));
    expect(resolution.should_prune_stored).toBe(false);
  });

  it("keeps the stored twin open when the route replaces only the primary", () => {
    const resolution = resolve(
      { kind: "session", session_id: "sid-c2" as Sid },
      { primary: OVERVIEW_PANE, secondary: LIST_PANE },
    );

    expect(resolution.state).toEqual({ primary: sessionPane("sid-c2"), secondary: LIST_PANE });
  });

  it("does not show the route pane twice when the stored twin already holds it", () => {
    const resolution = resolve(
      { kind: "artifact", artifact_id: "art-plan" as ArtifactId },
      { primary: OVERVIEW_PANE, secondary: artifactPane("art-plan") },
    );

    expect(resolution.state).toEqual({ primary: artifactPane("art-plan"), secondary: null });
  });

  it("ignores a route pane the run no longer contains and keeps the stored arrangement", () => {
    const resolution = resolve(
      { kind: "session", session_id: "sid-purged" as Sid },
      { primary: LIST_PANE, secondary: null },
    );

    expect(resolution.state).toEqual({ primary: LIST_PANE, secondary: null });
    expect(resolution.should_prune_stored).toBe(false);
  });
});

describe("validating persisted state against the run", () => {
  it("falls back to the overview and reports a prune when the stored session is gone", () => {
    const resolution = resolve(null, { primary: sessionPane("sid-purged"), secondary: null });

    expect(resolution.state).toEqual({ primary: OVERVIEW_PANE, secondary: null });
    expect(resolution.should_prune_stored).toBe(true);
  });

  it("falls back to the overview and reports a prune when the stored artifact is deleted", () => {
    const resolution = resolve(null, { primary: artifactPane("art-deleted"), secondary: null });

    expect(resolution.state).toEqual({ primary: OVERVIEW_PANE, secondary: null });
    expect(resolution.should_prune_stored).toBe(true);
  });

  it("restores the primary and closes a stale secondary", () => {
    const resolution = resolve(null, {
      primary: sessionPane("sid-c1"),
      secondary: artifactPane("art-deleted"),
    });

    expect(resolution.state).toEqual({ primary: sessionPane("sid-c1"), secondary: null });
    expect(resolution.should_prune_stored).toBe(true);
  });

  it("reports no prune when the caller had nothing stored", () => {
    const resolution = resolve(null, null);

    expect(resolution.state).toEqual({ primary: OVERVIEW_PANE, secondary: null });
    expect(resolution.should_prune_stored).toBe(false);
  });
});

describe("a sessions read that failed", () => {
  const resolveWithoutSessions = (storedState: RunWorkspaceState) =>
    resolveWorkspaceState({
      routePane: null,
      storedState,
      run: RUN,
      sessions: { kind: "unavailable" },
      purgedSessionIds: NO_PURGED_SESSIONS,
    });

  it("keeps a stored session pane it cannot prove is stale", () => {
    // Read as an empty list, a transient 5xx makes a prior attempt's pane
    // unresolvable — and the prune that follows is permanent, so the
    // arrangement does not come back when the next poll succeeds.
    const resolution = resolveWithoutSessions({
      primary: sessionPane("sid-c1-prior"),
      secondary: sessionPane("sid-c2"),
    });

    expect(resolution.state).toEqual({
      primary: sessionPane("sid-c1-prior"),
      secondary: sessionPane("sid-c2"),
    });
  });

  it("does not prune the stored arrangement", () => {
    const resolution = resolveWithoutSessions({
      primary: sessionPane("sid-c1-prior"),
      secondary: null,
    });

    expect(resolution.should_prune_stored).toBe(false);
  });

  it("still drops a stored artifact pane, which the run read can disprove", () => {
    // Only the session half is unknown. The run itself loaded, so its
    // artifacts are as knowable as ever and staleness there is still staleness.
    const resolution = resolveWithoutSessions({
      primary: artifactPane("art-deleted"),
      secondary: null,
    });

    expect(resolution.state).toEqual({ primary: OVERVIEW_PANE, secondary: null });
    expect(resolution.should_prune_stored).toBe(true);
  });

  it("opens a route pane naming a session the failed read would have listed", () => {
    const resolution = resolveWorkspaceState({
      routePane: { kind: "session", session_id: "sid-c1-prior" as Sid },
      storedState: { primary: LIST_PANE, secondary: null },
      run: RUN,
      sessions: { kind: "unavailable" },
      purgedSessionIds: NO_PURGED_SESSIONS,
    });

    expect(resolution.state.primary).toEqual(sessionPane("sid-c1-prior"));
  });
});

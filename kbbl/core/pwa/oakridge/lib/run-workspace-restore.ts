// Restore-and-precedence for the run workspace.
//
// Two rules, both decided here rather than left to the caller:
//
// 1. **The route wins when it names an entity.** A URL carrying a session or an
//    artifact is authoritative and overwrites the stored primary for that run;
//    the store is authoritative only for a bare `#oakridge/run/:id`. Two
//    sources of truth for selection do not surface as a visible defect — they
//    surface as a Back-button and refresh bug — so a deep link means what it
//    says.
//
// 2. **Persisted state is untrusted input.** Runs are deletable, sessions are
//    purgeable (`App.tsx` already handles `onSessionRemoved`), artifact ids go
//    stale, and with attempt history listed a stored pane can point at an
//    abandoned work order's session. Every pane — primary and secondary — is
//    validated against freshly fetched run/session data; an unresolvable
//    primary becomes the overview and an unresolvable secondary closes, and the
//    caller is told to prune rather than an error pane being rendered.

import type { RunDetail, RunSessionAttempt } from "../types";
import {
  DEFAULT_RUN_WORKSPACE_STATE,
  OVERVIEW_PANE,
  openInPane,
  type RoutePaneTarget,
  type RunWorkspacePane,
  type RunWorkspaceState,
} from "./run-workspace";

/**
 * The entity ids a run currently contains. Built once per resolution so pane
 * validation is a set lookup rather than a scan per pane.
 */
export interface RunEntityIndex {
  readonly session_ids: ReadonlySet<string>;
  readonly artifact_ids: ReadonlySet<string>;
}

/**
 * Every session the run shows and every artifact it holds.
 *
 * Sessions come from the attempt list *and* from the stages' own sids: a
 * session the run displays anywhere is one a pane may legitimately name, and
 * indexing only the attempt list would refuse to restore a pane the list view
 * can still link to.
 */
export const indexRunEntities = (
  run: RunDetail,
  sessions: readonly RunSessionAttempt[],
): RunEntityIndex => {
  const session_ids = new Set<string>();
  const artifact_ids = new Set<string>();
  for (const attempt of sessions) session_ids.add(attempt.session_id);
  for (const stage of run.stages) {
    if (stage.delegated_kbbl_sid !== null) session_ids.add(stage.delegated_kbbl_sid);
    for (const unit of stage.units ?? []) {
      if (unit.sid !== null) session_ids.add(unit.sid);
    }
    for (const artifact of stage.artifacts) artifact_ids.add(artifact.id);
  }
  return { session_ids, artifact_ids };
};

/**
 * Whether a pane still names something the run contains. The two bodiless
 * panes — overview and list — derive from the run itself, so they always
 * resolve for a run that loaded at all.
 */
export const isPaneResolvable = (pane: RunWorkspacePane, index: RunEntityIndex): boolean => {
  switch (pane.kind) {
    case "overview":
    case "list":
      return true;
    case "session":
      return index.session_ids.has(pane.session_id);
    case "artifact":
      return index.artifact_ids.has(pane.artifact_id);
  }
};

export interface RunWorkspaceResolutionInput {
  /** The pane the URL names, or null for a bare `#oakridge/run/:id`. */
  readonly routePane: RoutePaneTarget | null;
  /** What `readStoredRunWorkspace` returned, or null when the caller has nothing. */
  readonly storedState: RunWorkspaceState | null;
  readonly run: RunDetail;
  readonly sessions: readonly RunSessionAttempt[];
}

export interface RunWorkspaceResolution {
  readonly state: RunWorkspaceState;
  /**
   * True when validation dropped a pane the store still holds, so the caller
   * should rewrite (or drop) the stored entry. False whenever the stored value
   * survived intact, including when there was nothing stored at all.
   */
  readonly should_prune_stored: boolean;
}

/**
 * The arrangement to render, and whether the stored entry that produced it is
 * now stale.
 *
 * A route pane that does not resolve is ignored rather than fatal: the operator
 * keeps the arrangement they had instead of losing it to someone else's dead
 * link. Only the *stored* state can report a prune, because only the stored
 * state is something this browser owns and can correct.
 */
export const resolveWorkspaceState = ({
  routePane,
  storedState,
  run,
  sessions,
}: RunWorkspaceResolutionInput): RunWorkspaceResolution => {
  const index = indexRunEntities(run, sessions);
  const stored = storedState ?? DEFAULT_RUN_WORKSPACE_STATE;

  const primaryResolves = isPaneResolvable(stored.primary, index);
  const secondaryResolves = stored.secondary !== null && isPaneResolvable(stored.secondary, index);

  const restored: RunWorkspaceState = {
    primary: primaryResolves ? stored.primary : OVERVIEW_PANE,
    secondary: secondaryResolves ? stored.secondary : null,
  };
  const should_prune_stored =
    storedState !== null && (!primaryResolves || (stored.secondary !== null && !secondaryResolves));

  if (routePane !== null && isPaneResolvable(routePane, index)) {
    return { state: openInPane(restored, "primary", routePane), should_prune_stored };
  }
  return { state: restored, should_prune_stored };
};

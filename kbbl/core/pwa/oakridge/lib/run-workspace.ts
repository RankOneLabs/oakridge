// The run command center's pane model.
//
// A run workspace is exactly two slots — never a window manager. There is no
// resize, no drag, no z-ordering: `primary` is always occupied and `secondary`
// is the optional twin. The state deliberately has no representation for an
// empty primary, which is what forces `closePane("primary")` to promote the
// secondary rather than mint an illegal state a renderer would have to guess at.

import type { ArtifactId, Sid } from "../../lib/ids";

/**
 * The pane variants that name a domain entity, and so the only ones a URL can
 * carry. `lib/hash.ts` parses `#oakridge/run/:id/session/:sid` and
 * `#oakridge/run/:id/artifact/:artifactId` into one of these.
 *
 * It is defined here rather than in `lib/hash.ts` so the route target and the
 * workspace pane are one type, not two hand-synced ones: a route that names an
 * entity *is* a pane, and `resolveWorkspaceState` promotes it without a
 * conversion step that could drift.
 */
export type RoutePaneTarget =
  | { kind: "session"; session_id: Sid }
  | { kind: "artifact"; artifact_id: ArtifactId };

/**
 * What one slot can show. A closed discriminated union — a tag plus the payload
 * that variant needs — so adding a pane body is a compile error at every
 * consumer rather than a silently unhandled string.
 *
 * `session` and `artifact` bodies arrive in c3; the model carries them from the
 * first commit so the persisted shape never has to be migrated to admit them.
 */
export type RunWorkspacePane =
  | { kind: "overview" }
  | { kind: "list" }
  | RoutePaneTarget;

export type RunWorkspacePaneKind = RunWorkspacePane["kind"];

export type RunWorkspaceSlot = "primary" | "secondary";

export interface RunWorkspaceState {
  readonly primary: RunWorkspacePane;
  readonly secondary: RunWorkspacePane | null;
}

export const OVERVIEW_PANE: RunWorkspacePane = { kind: "overview" };
export const LIST_PANE: RunWorkspacePane = { kind: "list" };

/** What a run shows before the operator has arranged anything. */
export const DEFAULT_RUN_WORKSPACE_STATE: RunWorkspaceState = {
  primary: OVERVIEW_PANE,
  secondary: null,
};

/**
 * Structural pane identity. Two panes are the same when they would render the
 * same thing, which is what lets the transforms refuse to show one pane in both
 * slots at once.
 */
export const arePanesEqual = (
  left: RunWorkspacePane | null,
  right: RunWorkspacePane | null,
): boolean => {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "session" && right.kind === "session") {
    return left.session_id === right.session_id;
  }
  if (left.kind === "artifact" && right.kind === "artifact") {
    return left.artifact_id === right.artifact_id;
  }
  return true;
};

/** The panes currently on screen, primary first. */
export const panesOf = (state: RunWorkspaceState): readonly RunWorkspacePane[] =>
  state.secondary === null ? [state.primary] : [state.primary, state.secondary];

export const isTwinView = (state: RunWorkspaceState): boolean => state.secondary !== null;

/**
 * Show `pane` in `slot`, replacing whatever was there.
 *
 * Opening a pane the *other* slot already shows collapses rather than
 * duplicating it: opening into the primary closes a secondary showing the same
 * thing, and opening into the secondary something the primary already shows is
 * a no-op. Two slots rendering one pane is never what the operator asked for.
 */
export const openInPane = (
  state: RunWorkspaceState,
  slot: RunWorkspaceSlot,
  pane: RunWorkspacePane,
): RunWorkspaceState => {
  if (slot === "primary") {
    return {
      primary: pane,
      secondary: arePanesEqual(state.secondary, pane) ? null : state.secondary,
    };
  }
  if (arePanesEqual(state.primary, pane)) return state;
  return { primary: state.primary, secondary: pane };
};

/**
 * Close `slot`. Closing the primary promotes the secondary into it; with no
 * secondary to promote the workspace falls back to the overview, because
 * "no primary" is not a state this model can hold.
 */
export const closePane = (
  state: RunWorkspaceState,
  slot: RunWorkspaceSlot,
): RunWorkspaceState => {
  if (slot === "secondary") return { primary: state.primary, secondary: null };
  if (state.secondary !== null) return { primary: state.secondary, secondary: null };
  return DEFAULT_RUN_WORKSPACE_STATE;
};

/**
 * Drop the twin and keep the primary. Named separately from
 * `closePane(state, "secondary")` because it is a different operator intent —
 * "back to one pane" rather than "close that pane" — and the two surfaces that
 * offer it (the pane chrome and the narrow-screen layout) read better for it.
 */
export const collapseToSingle = (state: RunWorkspaceState): RunWorkspaceState =>
  closePane(state, "secondary");

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
//    purgeable, artifact ids go stale, and with attempt history listed a stored
//    pane can point at an abandoned work order's session. Every pane — primary
//    and secondary — is validated against freshly fetched run/session data; an
//    unresolvable primary becomes the overview and an unresolvable secondary
//    closes, and the caller is told to prune rather than an error pane being
//    rendered.
//
//    `validateWorkspacePanes` is that rule on its own, because restore is not
//    the only moment a pane goes stale: the inbox can report a session purged
//    while a pane is holding it, and that is the same shape of problem with the
//    same answer.
//
//    The rule only drops what it can *disprove*. Validating against a read that
//    failed is not validation — it concludes the run contains nothing and takes
//    the arrangement with it, permanently, because the same pass prunes the
//    store. So the index says whether it knows the run's sessions at all, and
//    an unknown session half leaves session panes standing.

import type { RunDetail } from "../types";
import { attemptsOf, type RunSessionsRead } from "./run-sessions";
import {
  DEFAULT_RUN_WORKSPACE_STATE,
  OVERVIEW_PANE,
  openInPane,
  type RoutePaneTarget,
  type RunWorkspacePane,
  type RunWorkspaceState,
} from "./run-workspace";

/**
 * The sessions a run is known to contain — or the fact that the attempt read
 * did not land, which is a different thing from the run containing none.
 *
 * Validation can only drop what it can disprove. With the attempt list absent,
 * the stage sids alone are an incomplete picture of the run's sessions, and
 * treating them as the whole picture is what turns a transient 5xx into a
 * pruned arrangement.
 */
export type RunSessionIndex =
  | { readonly kind: "known"; readonly ids: ReadonlySet<string> }
  | { readonly kind: "unknown" };

/**
 * The entity ids a run currently contains. Built once per resolution so pane
 * validation is a set lookup rather than a scan per pane.
 */
export interface RunEntityIndex {
  readonly sessions: RunSessionIndex;
  /**
   * Sids kbbl's inbox has reported gone server-side. Held apart from the index
   * rather than subtracted into it because the two are different kinds of
   * knowledge: the index says what the run's reads listed, this says what is
   * positively gone. A purge stays authoritative even when the attempt read
   * failed, so it cannot be subtracted from a set that may not exist.
   */
  readonly purged_session_ids: ReadonlySet<string>;
  readonly artifact_ids: ReadonlySet<string>;
}

export interface RunEntityIndexInput {
  readonly run: RunDetail;
  readonly sessions: RunSessionsRead;
  /**
   * Sids kbbl's inbox has reported gone server-side. Oakridge's own reads keep
   * listing a purged session — the work order it belongs to is a durable
   * record — so the run's data alone cannot tell that the transcript behind it
   * no longer exists. Carrying them here makes a purge the same kind of
   * staleness as a deleted run or a stale artifact, resolved by one rule.
   */
  readonly purgedSessionIds: ReadonlySet<string>;
}

/**
 * Every session the run shows and every artifact it holds.
 *
 * Sessions come from the attempt list *and* from the stages' own sids: a
 * session the run displays anywhere is one a pane may legitimately name, and
 * indexing only the attempt list would refuse to restore a pane the list view
 * can still link to. When the attempt read has not landed the session half is
 * `unknown` rather than a partial set — artifacts still index, because they
 * come from the run read, which did land.
 */
export const indexRunEntities = ({
  run,
  sessions,
  purgedSessionIds,
}: RunEntityIndexInput): RunEntityIndex => {
  const artifact_ids = new Set<string>();
  const session_ids = new Set<string>();
  for (const attempt of attemptsOf(sessions)) session_ids.add(attempt.session_id);
  for (const stage of run.stages) {
    if (stage.delegated_kbbl_sid !== null) session_ids.add(stage.delegated_kbbl_sid);
    for (const unit of stage.units ?? []) {
      if (unit.sid !== null) session_ids.add(unit.sid);
    }
    for (const artifact of stage.artifacts) artifact_ids.add(artifact.id);
  }
  return {
    sessions:
      sessions.kind === "loaded" ? { kind: "known", ids: session_ids } : { kind: "unknown" },
    purged_session_ids: purgedSessionIds,
    artifact_ids,
  };
};

/**
 * Whether a pane still names something the run contains. The two bodiless
 * panes — overview and list — derive from the run itself, so they always
 * resolve for a run that loaded at all.
 *
 * A session pane asks two questions in order, because the answers come from
 * different places: a purge is positive knowledge that the transcript is gone
 * and settles it on its own, and only then does the run's own list get a say —
 * and only when that list actually loaded.
 */
export const isPaneResolvable = (pane: RunWorkspacePane, index: RunEntityIndex): boolean => {
  switch (pane.kind) {
    case "overview":
    case "list":
      return true;
    case "session":
      if (index.purged_session_ids.has(pane.session_id)) return false;
      if (index.sessions.kind === "unknown") return true;
      return index.sessions.ids.has(pane.session_id);
    case "artifact":
      return index.artifact_ids.has(pane.artifact_id);
  }
};

export interface ValidatedWorkspaceState {
  readonly state: RunWorkspaceState;
  /** True when validation dropped at least one pane the input still held. */
  readonly dropped_a_pane: boolean;
}

/**
 * Every pane that no longer names something the run contains, dropped.
 *
 * An unresolvable primary becomes the overview and an unresolvable secondary
 * closes — never an error pane, because a pane pointing at something that is
 * gone is not a failure the operator can act on. One transform for every way a
 * pane goes stale: a deleted run, an artifact that never existed, a session
 * purged out from under an open pane.
 */
export const validateWorkspacePanes = (
  state: RunWorkspaceState,
  index: RunEntityIndex,
): ValidatedWorkspaceState => {
  const primaryResolves = isPaneResolvable(state.primary, index);
  const secondaryResolves = state.secondary === null || isPaneResolvable(state.secondary, index);
  return {
    state: {
      primary: primaryResolves ? state.primary : OVERVIEW_PANE,
      secondary: secondaryResolves ? state.secondary : null,
    },
    dropped_a_pane: !primaryResolves || !secondaryResolves,
  };
};

export interface RunWorkspaceResolutionInput {
  /** The pane the URL names, or null for a bare `#oakridge/run/:id`. */
  readonly routePane: RoutePaneTarget | null;
  /** What `readStoredRunWorkspace` returned, or null when the caller has nothing. */
  readonly storedState: RunWorkspaceState | null;
  readonly run: RunDetail;
  readonly sessions: RunSessionsRead;
  readonly purgedSessionIds: ReadonlySet<string>;
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
  purgedSessionIds,
}: RunWorkspaceResolutionInput): RunWorkspaceResolution => {
  const index = indexRunEntities({ run, sessions, purgedSessionIds });
  const stored = storedState ?? DEFAULT_RUN_WORKSPACE_STATE;

  const validated = validateWorkspacePanes(stored, index);
  const should_prune_stored = storedState !== null && validated.dropped_a_pane;

  if (routePane !== null && isPaneResolvable(routePane, index)) {
    return { state: openInPane(validated.state, "primary", routePane), should_prune_stored };
  }
  return { state: validated.state, should_prune_stored };
};

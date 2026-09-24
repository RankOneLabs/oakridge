import { useCallback, useEffect, useRef, useState } from "react";

import type { RunDetail, RunSessionAttempt } from "../types";
import {
  closePane,
  collapseToSingle,
  moveToOtherSlot,
  openInPane,
  type RoutePaneTarget,
  type RunWorkspacePane,
  type RunWorkspaceSlot,
  type RunWorkspaceState,
} from "../lib/run-workspace";
import { resolveWorkspaceState } from "../lib/run-workspace-restore";
import {
  pruneStoredRunWorkspace,
  readStoredRunWorkspace,
  writeStoredRunWorkspace,
} from "../lib/run-workspace-storage";

export interface RunWorkspaceStateInput {
  readonly runId: string;
  readonly routePane: RoutePaneTarget | null;
  /** Undefined until `GET /runs/:id` resolves; restore waits for it. */
  readonly run: RunDetail | undefined;
  /** Undefined until `GET /runs/:id/sessions` resolves; restore waits for it. */
  readonly sessions: readonly RunSessionAttempt[] | undefined;
}

export interface RunWorkspaceStateHandle {
  /** Null until the stored arrangement has been restored and validated. */
  readonly state: RunWorkspaceState | null;
  readonly openPane: (pane: RunWorkspacePane, slot: RunWorkspaceSlot) => void;
  readonly closeSlot: (slot: RunWorkspaceSlot) => void;
  readonly moveSlot: (slot: RunWorkspaceSlot) => void;
  readonly collapse: () => void;
}

/** A stable identity for the route's pane, so effects fire on a real change. */
const routePaneKeyOf = (pane: RoutePaneTarget | null): string => {
  if (pane === null) return "";
  return pane.kind === "session" ? `session:${pane.session_id}` : `artifact:${pane.artifact_id}`;
};

/**
 * Owns the run's pane arrangement: restore on mount, apply later route changes,
 * persist every change.
 *
 * Restore waits for both reads because validating a pane against half-loaded
 * data would drop panes that are perfectly valid. The caller is expected to
 * mount this keyed by run id, so moving between runs starts a fresh restore
 * rather than carrying one run's arrangement into another.
 */
export function useRunWorkspaceState({
  runId,
  routePane,
  run,
  sessions,
}: RunWorkspaceStateInput): RunWorkspaceStateHandle {
  const [state, setState] = useState<RunWorkspaceState | null>(null);
  const routePaneKey = routePaneKeyOf(routePane);
  // What the route last contributed. Restoring and re-applying are one concern
  // seen twice: without this, every unrelated re-render would re-assert the
  // route pane and undo whatever the operator just opened.
  const appliedRouteKey = useRef<string | null>(null);

  useEffect(() => {
    if (state !== null || run === undefined || sessions === undefined) return;
    const resolution = resolveWorkspaceState({
      routePane,
      storedState: readStoredRunWorkspace(runId),
      run,
      sessions,
    });
    if (resolution.should_prune_stored) pruneStoredRunWorkspace(runId);
    appliedRouteKey.current = routePaneKey;
    setState(resolution.state);
  }, [state, run, sessions, routePane, routePaneKey, runId]);

  useEffect(() => {
    if (state === null || appliedRouteKey.current === routePaneKey) return;
    appliedRouteKey.current = routePaneKey;
    if (routePane === null) return;
    setState((current) => (current === null ? current : openInPane(current, "primary", routePane)));
  }, [state, routePane, routePaneKey]);

  useEffect(() => {
    if (state === null) return;
    writeStoredRunWorkspace(runId, state);
  }, [runId, state]);

  const openPane = useCallback((pane: RunWorkspacePane, slot: RunWorkspaceSlot) => {
    setState((current) => (current === null ? current : openInPane(current, slot, pane)));
  }, []);

  const closeSlot = useCallback((slot: RunWorkspaceSlot) => {
    setState((current) => (current === null ? current : closePane(current, slot)));
  }, []);

  const moveSlot = useCallback((slot: RunWorkspaceSlot) => {
    setState((current) => (current === null ? current : moveToOtherSlot(current, slot)));
  }, []);

  const collapse = useCallback(() => {
    setState((current) => (current === null ? current : collapseToSingle(current)));
  }, []);

  return { state, openPane, closeSlot, moveSlot, collapse };
}

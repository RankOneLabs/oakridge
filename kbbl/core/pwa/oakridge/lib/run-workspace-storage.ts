// Per-run pane-arrangement persistence, following `core/pwa/lib/storage.ts`:
// every access is try/catch-guarded, every read is validated, and nothing here
// throws. localStorage is absent under SSR and raises `SecurityError` in a
// sandboxed frame, and a workspace that cannot restore its panes is not a
// reason to fail the whole route.
//
// Keyed per run — `kbbl.oakridge.runWorkspace.<runId>` — so each run restores
// its own arrangement independently rather than the last-visited run's.
//
// This stays client-side even though backend changes were on the table for this
// cohort: the arrangement is per-operator-per-browser and oakridge-dbos has no
// per-operator persistence surface to hang it on.

import type { ArtifactId, Sid } from "../../lib/ids";
import {
  DEFAULT_RUN_WORKSPACE_STATE,
  LIST_PANE,
  OVERVIEW_PANE,
  type RunWorkspacePane,
  type RunWorkspaceState,
} from "./run-workspace";

export const RUN_WORKSPACE_STORAGE_PREFIX = "kbbl.oakridge.runWorkspace.";

export const runWorkspaceStorageKey = (runId: string): string =>
  `${RUN_WORKSPACE_STORAGE_PREFIX}${runId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * A stored pane, or null when the stored value is not one. Anything written by
 * an older build, a hand-edited devtools value, or a half-written entry lands
 * here, so the guard is exhaustive on `kind` and checks each variant's payload
 * rather than trusting the tag.
 */
const parseStoredPane = (value: unknown): RunWorkspacePane | null => {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "overview":
      return OVERVIEW_PANE;
    case "list":
      return LIST_PANE;
    case "session": {
      const sessionId = nonEmptyString(value.session_id);
      return sessionId === null ? null : { kind: "session", session_id: sessionId as Sid };
    }
    case "artifact": {
      const artifactId = nonEmptyString(value.artifact_id);
      return artifactId === null ? null : { kind: "artifact", artifact_id: artifactId as ArtifactId };
    }
    default:
      return null;
  }
};

/**
 * A stored arrangement, or null when the primary is unreadable.
 *
 * An unreadable *secondary* is not fatal — the twin is optional, so a bad half
 * is dropped and the primary still restores. An unreadable primary has no such
 * fallback within the stored value, so the whole entry is rejected and the
 * caller gets the default.
 */
const parseStoredState = (value: unknown): RunWorkspaceState | null => {
  if (!isRecord(value)) return null;
  const primary = parseStoredPane(value.primary);
  if (primary === null) return null;
  return { primary, secondary: parseStoredPane(value.secondary) };
};

/**
 * The run's stored arrangement, or the overview default for an absent,
 * non-JSON, malformed or wrong-shaped entry. Never throws.
 */
export function readStoredRunWorkspace(runId: string): RunWorkspaceState {
  try {
    const raw = localStorage.getItem(runWorkspaceStorageKey(runId));
    if (raw === null) return DEFAULT_RUN_WORKSPACE_STATE;
    return parseStoredState(JSON.parse(raw) as unknown) ?? DEFAULT_RUN_WORKSPACE_STATE;
  } catch {
    return DEFAULT_RUN_WORKSPACE_STATE;
  }
}

/** Persist the run's arrangement. Silently does nothing when storage refuses. */
export function writeStoredRunWorkspace(runId: string, state: RunWorkspaceState): void {
  try {
    localStorage.setItem(runWorkspaceStorageKey(runId), JSON.stringify(state));
  } catch {}
}

/** Drop the run's stored arrangement — used when it no longer names anything real. */
export function pruneStoredRunWorkspace(runId: string): void {
  try {
    localStorage.removeItem(runWorkspaceStorageKey(runId));
  } catch {}
}

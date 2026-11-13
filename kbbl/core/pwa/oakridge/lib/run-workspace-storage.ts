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
import { artifactRevisionIdOf, logicalItemIdOf } from "./grading-ids";
import {
  DEFAULT_RUN_WORKSPACE_STATE,
  GRADING_PANE,
  LIST_PANE,
  OVERVIEW_PANE,
  arePanesEqual,
  type RunWorkspacePane,
  type RecordedPaneContext,
  type RunWorkspaceState,
} from "./run-workspace";

export const RUN_WORKSPACE_STORAGE_PREFIX = "kbbl.oakridge.runWorkspace.";

export const runWorkspaceStorageKey = (runId: string): string =>
  `${RUN_WORKSPACE_STORAGE_PREFIX}${runId}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Optional recorded context is retained across refreshes, never reconstructed from labels. */
const parseRecordedContext = (value: Record<string, unknown>): RecordedPaneContext => {
  const question = isRecord(value.question) && typeof value.question.question_id === "string" && typeof value.question.question_version === "string"
    ? value.question as unknown as import("../grading-contracts/grading/question").ObservationQuestionKey : null;
  return {
    ...(typeof value.run_id === "string" ? { run_id: value.run_id } : {}),
    ...(typeof value.unit_id === "string" ? { unit_id: value.unit_id } : {}),
    ...(typeof value.artifact_id === "string" ? { artifact_id: value.artifact_id as ArtifactId } : {}),
    ...(typeof value.revision_id === "string" ? { revision_id: value.revision_id } : {}),
    ...(typeof value.item_path === "string" ? { item_path: value.item_path } : {}),
    ...(typeof value.subject_occurrence_id === "string" ? { subject_occurrence_id: value.subject_occurrence_id } : {}),
    ...("question" in value ? { question } : {}),
  };
};

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
    case "grading":
      return GRADING_PANE;
    case "item": {
      if (!isRecord(value.selection)) return null;
      const source_revision_id = nonEmptyString(value.selection.source_revision_id);
      const item_path = typeof value.selection.item_path === "string" ? value.selection.item_path : null;
      if (source_revision_id === null || item_path === null) return null;
      const selection = { source_revision_id: artifactRevisionIdOf(source_revision_id), item_path };
      if (!("task_id" in value.selection)) return { kind: "item", selection, ...parseRecordedContext(value) };
      if (value.selection.task_id === null) return { kind: "item", selection: { ...selection, task_id: null }, ...parseRecordedContext(value) };
      const task_id = nonEmptyString(value.selection.task_id);
      return task_id === null ? null : { kind: "item", selection: { ...selection, task_id: logicalItemIdOf(task_id) }, ...parseRecordedContext(value) };
    }
    case "task": {
      const taskId = nonEmptyString(value.task_id);
      return taskId === null ? null : { kind: "task", task_id: taskId, ...parseRecordedContext(value) };
    }
    case "session": {
      const sessionId = nonEmptyString(value.session_id);
      return sessionId === null ? null : { kind: "session", session_id: sessionId as Sid };
    }
    case "prompt": {
      const unit_id = nonEmptyString(value.unit_id);
      const attempt_id = nonEmptyString(value.attempt_id);
      return unit_id === null || attempt_id === null ? null : { kind: "prompt", unit_id, attempt_id };
    }
    case "unit": {
      const unit_id = nonEmptyString(value.unit_id);
      return unit_id === null ? null : { kind: "unit", unit_id };
    }
    case "artifact": {
      const artifactId = nonEmptyString(value.artifact_id);
      return artifactId === null ? null : { kind: "artifact", artifact_id: artifactId as ArtifactId, ...(typeof value.revision_id === "string" ? { revision_id: value.revision_id } : {}), ...(typeof value.run_id === "string" ? { run_id: value.run_id } : {}), ...(typeof value.unit_id === "string" ? { unit_id: value.unit_id } : {}) };
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
 *
 * A secondary that duplicates the primary is dropped for the same reason it is
 * unreadable: `openInPane` refuses to put one pane in both slots, so an entry
 * that says otherwise came from an older build or a hand edit, and restoring it
 * would reintroduce a state the model cannot otherwise reach.
 */
const parseStoredState = (value: unknown): RunWorkspaceState | null => {
  if (!isRecord(value)) return null;
  const primary = parseStoredPane(value.primary);
  if (primary === null) return null;
  const secondary = parseStoredPane(value.secondary);
  return { primary, secondary: arePanesEqual(primary, secondary) ? null : secondary };
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

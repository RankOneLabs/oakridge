/**
 * Delete epics whose stored role selections name models or efforts the
 * pinned agents no longer advertise.
 *
 * `epics.planner_model` / `worker_model` are free text, written when the epic
 * was created and forwarded to ACP verbatim at dispatch. An agent bump that
 * renames or drops an id (claude-agent-acp 0.70.0's `claude-fable-5[1m]` is
 * 0.76.0's `claude-fable-5-1[1m]`; codex-acp 1.11.0 dropped `gpt-5.4-mini`)
 * strands those rows: every launch fails `requested_model_unsupported`, and
 * nothing in the app rewrites them. This purges them — the selection cannot
 * be repaired without guessing which current model the operator meant.
 *
 * Dry-run by default; `--apply` performs the deletion. Deletion cascades
 * through the epic's spec exactly as DELETE /epics/:id does.
 *
 *   bun run kbbl/scripts/purge-legacy-epics.ts --db kbbl/data/kbbl.db
 *   bun run kbbl/scripts/purge-legacy-epics.ts --db kbbl/data/kbbl.db --apply
 *
 * By default only epics that can still dispatch (`pending` / `active`) are
 * considered; `--include-archived` widens it to the whole table.
 */

import { parseArgs } from "node:util";

import { openDb } from "../core/db/connection";
import { deleteEpicCascade, listAllEpics, type Epic } from "../core/db/epics";
import { isCurrentRuntimeSelection } from "../core/runtime";
import type { EpicStatus } from "../core/types/task-tracker";

/** Epic statuses that can still start a session. */
const DISPATCHABLE: readonly EpicStatus[] = ["pending", "active"];

export function isLegacyEpic(epic: Epic): boolean {
  return (
    !isCurrentRuntimeSelection(epic.planner_model_selection) ||
    !isCurrentRuntimeSelection(epic.worker_model_selection)
  );
}

export function selectPurgeableEpics(
  epics: readonly Epic[],
  includeArchived: boolean,
): Epic[] {
  return epics
    .filter((epic) => includeArchived || DISPATCHABLE.includes(epic.status))
    .filter(isLegacyEpic);
}

function describe(epic: Epic): string {
  const role = (label: string, selection: Epic["planner_model_selection"]): string =>
    `${label}=${selection.runtime}:${selection.model}/${selection.effort ?? "-"}`;
  return [
    epic.id,
    `${epic.status}/${epic.current_stage}`,
    role("planner", epic.planner_model_selection),
    role("worker", epic.worker_model_selection),
    epic.created_at,
    epic.title,
  ].join("  ");
}

function main(): void {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      apply: { type: "boolean", default: false },
      "include-archived": { type: "boolean", default: false },
    },
  });

  const dbPath = values.db;
  if (dbPath === undefined) {
    console.error("--db <path to kbbl.db> is required");
    process.exit(2);
  }

  // Read through the repository's row mapper so the selections read exactly
  // as the dispatcher forwards them, rather than re-reading the columns here.
  const db = openDb(dbPath);
  const epics = listAllEpics(db);
  const doomed = selectPurgeableEpics(epics, values["include-archived"]);

  console.log(
    `${epics.length} epics, ${doomed.length} with selections the pinned agents no longer advertise` +
      (values["include-archived"] ? "" : " (dispatchable only)"),
  );
  for (const epic of doomed) console.log(`  ${describe(epic)}`);

  if (!values.apply) {
    console.log("\ndry run — pass --apply to delete these and their specs");
    return;
  }

  let deleted = 0;
  for (const epic of doomed) if (deleteEpicCascade(db, epic.id)) deleted += 1;
  console.log(`\ndeleted ${deleted} epics and their specs`);
}

// Guarded so the selection transforms above stay importable by tests.
if (import.meta.main) main();

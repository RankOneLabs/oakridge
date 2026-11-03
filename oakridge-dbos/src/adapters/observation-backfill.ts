import type { Kysely } from "kysely";
import { err, ok, type Result, type TracedError } from "../domain/primitives";
import type { DB } from "../storage/db-types";
import { readCollaborationThreadRows, type CollaborationThreadBatchRow } from "../storage/observation-backfill-store";
import { readPinnedDefinition } from "../storage/read-store";
import { mapCollaborationThread } from "./observation-mapping";
import type { ObservationOptions } from "./observation";
import type { SourceEventOutcome } from "./observation-wire";
import { canonicalJson } from "canonical-json";

export type BackfillPosition =
  | { readonly source: "collaboration_thread"; readonly created_at: string; readonly id: string }
  | { readonly source: "done" };
export interface BackfillRequest { readonly max_rows: number; readonly position: BackfillPosition | null }
export interface BackfillSourceCounts { readonly active: number; readonly archived: number }
export interface BackfillCounts { readonly collaboration_thread: BackfillSourceCounts }
export interface BackfillResult { readonly position: BackfillPosition; readonly counts: BackfillCounts;
  readonly rows_processed: number; readonly is_done: boolean }
export const INITIAL_BACKFILL_POSITION: BackfillPosition = { source: "collaboration_thread", created_at: new Date(0).toISOString(), id: "" };
export const EMPTY_BACKFILL_COUNTS: BackfillCounts = { collaboration_thread: { active: 0, archived: 0 } };

export type { CollaborationThreadBatchRow } from "../storage/observation-backfill-store";
const failure = (operation: string, entity_id: string, cause: unknown): Result<never, TracedError> =>
  err({ operation, entity_id, detail: String(cause) });

export async function readCollaborationThreadBatch(db: Kysely<DB>, position: Extract<BackfillPosition, { source: "collaboration_thread" }>,
  limit: number): Promise<Result<readonly CollaborationThreadBatchRow[], TracedError>> {
  try {
    return ok(await readCollaborationThreadRows(db, position, limit));
  } catch (cause) { return failure("read_collaboration_thread_batch", position.id, cause); }
}

function incrementCollaborationCount(counts: BackfillCounts, archived_at: Date | null): BackfillCounts {
  const kind = archived_at === null ? "active" : "archived";
  return { collaboration_thread: { ...counts.collaboration_thread, [kind]: counts.collaboration_thread[kind] + 1 } };
}

interface BackfillCheckpoint { readonly position: BackfillPosition; readonly counts: BackfillCounts }
interface BackfillDelivery extends BackfillCheckpoint { readonly previous: BackfillPosition; readonly outcome: Extract<SourceEventOutcome, { kind: "collaboration_thread" }> | null;
  readonly replay: boolean }
async function serviceCheckpoint(options: ObservationOptions): Promise<BackfillCheckpoint> {
  const response = await (options.fetcher ?? fetch)(new URL("/v1/sources/oakridge/backfill", options.url),
    { headers: { authorization: `Bearer ${options.token}` } });
  if (!response.ok) throw new Error(`observation backfill checkpoint HTTP ${response.status}`);
  return response.json() as Promise<BackfillCheckpoint>;
}
async function postBackfill(options: ObservationOptions, delivery: BackfillDelivery): Promise<void> {
  const response = await (options.fetcher ?? fetch)(new URL("/v1/sources/oakridge/backfill", options.url), {
    method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
    body: JSON.stringify(delivery) });
  if (!response.ok) throw new Error(`observation backfill delivery HTTP ${response.status}: ${await response.text()}`);
}

/** Operator-invoked, bounded pass. The service persists each acknowledged position. */
export async function runObservationBackfill(db: Kysely<DB>, options: ObservationOptions, request: BackfillRequest):
  Promise<Result<BackfillResult, TracedError>> {
  if (!Number.isInteger(request.max_rows) || request.max_rows < 1 || request.max_rows > 1000)
    return failure("observation_backfill", "max_rows", "max_rows must be 1..1000");
  try {
    const checkpoint = await serviceCheckpoint(options);
    let position = request.position ?? checkpoint.position;
    let counts = checkpoint.counts;
    let rows_processed = 0;
    const current = canonicalJson(position);
    const previous = canonicalJson(checkpoint.position);
    if (!current.ok || !previous.ok) throw new Error("observation_backfill: invalid checkpoint position");
    const replay = request.position !== null && current.value !== previous.value;
    if (replay) counts = EMPTY_BACKFILL_COUNTS;
    while (rows_processed < request.max_rows && position.source !== "done") {
      const batch = await readCollaborationThreadBatch(db, position, request.max_rows - rows_processed);
      if (!batch.ok) return batch;
      if (!batch.value.length) {
        const next: BackfillPosition = { source: "done" };
        await postBackfill(options, { previous: position, position: next, counts, outcome: null, replay });
        position = next;
        continue;
      }
      for (const { thread, archived_at, messages } of batch.value) {
        const definition = await readPinnedDefinition(db, thread.run_id);
        const outcome = mapCollaborationThread({ thread, messages, definition });
        const next: BackfillPosition = { source: "collaboration_thread", created_at: thread.created_at.toISOString(), id: thread.id };
        const nextCounts = incrementCollaborationCount(counts, archived_at);
        await postBackfill(options, { previous: position, position: next, counts: nextCounts, outcome, replay });
        position = next; counts = nextCounts; rows_processed++;
      }
    }
    return ok({ position, counts, rows_processed, is_done: position.source === "done" });
  } catch (cause) { return failure("observation_backfill", "delivery", cause); }
}

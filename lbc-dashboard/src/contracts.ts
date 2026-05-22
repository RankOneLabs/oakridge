/**
 * Wire schemas for the lbc-dashboard backend.
 *
 * Single source of truth for the shapes that cross the network
 * between the Hono backend (server.ts + store.ts) and the PWA
 * (pwa/lib/types.ts re-exports the inferred types).
 *
 * Inbound request bodies don't exist — every route is GET and
 * path params validate inside store.ts::parseCellId. So this file
 * only carries response shapes.
 */
import { z } from "zod";

// All wire schemas use ``z.strictObject`` rather than the default
// ``z.object``: in Zod v4, ``z.object`` strips unknown keys at parse
// time, which would let a new field added to store.ts pass silently
// to the wire and reach the PWA. The whole point of the boundary
// parse in server.ts is to *catch* that drift as a visible 500 —
// strict mode is what makes that work.

export const CellEventSchema = z.strictObject({
  ts: z.string(),
  kind: z.string(),
  // Payload shapes are kind-dependent and heterogeneous; a
  // discriminated union over kinds would need an audit of
  // legit-biz-club's event vocabulary that is out of scope here.
  payload: z.record(z.string(), z.unknown()),
});

export const EvalScoreSchema = z.strictObject({
  dimension: z.string(),
  value: z.number(),
  source: z.string(),
});

export const CellSummarySchema = z.strictObject({
  cell_id: z.string(),
  run_ts: z.string(),
  target_name: z.string(),
  condition_name: z.string(),
  cell_dir: z.string(),
  status: z.enum(["active", "ended"]),
  last_activity_ms: z.number(),
  event_count: z.number(),
});

// Spread the summary shape rather than calling ``.extend(...)`` so
// the resulting schema is unambiguously a fresh strict object — no
// dependence on whether ``.extend`` preserves strictness across
// Zod versions.
export const CellDetailSchema = z.strictObject({
  ...CellSummarySchema.shape,
  events: z.array(CellEventSchema),
  artifact_filename: z.string().nullable(),
  commit_count: z.number(),
});

export const CommitSnapshotSchema = z.strictObject({
  index: z.number(),
  filename: z.string(),
  content: z.string(),
});

// --- response envelopes -------------------------------------------------

export const CellsResponseSchema = z.strictObject({
  cells: z.array(CellSummarySchema),
});

export const ArtifactResponseSchema = z.strictObject({
  content: z.string(),
});

// ``scores`` is non-empty ``EvalScore[]`` or ``null``. The writer
// skips zero-score sidecars and readEvalScores folds any
// empty/all-malformed list back to ``null``, so an empty array
// never reaches the wire — ``.nonempty()`` enforces that on the
// schema so an accidental ``[]`` from a future writer becomes a
// 500 instead of passing through.
export const EvalResponseSchema = z.strictObject({
  scores: z.array(EvalScoreSchema).nonempty().nullable(),
});

export const CommitsResponseSchema = z.strictObject({
  commits: z.array(CommitSnapshotSchema),
});

// --- inferred types ------------------------------------------------------

export type CellEvent = z.infer<typeof CellEventSchema>;
export type EvalScore = z.infer<typeof EvalScoreSchema>;
export type CellSummary = z.infer<typeof CellSummarySchema>;
export type CellDetail = z.infer<typeof CellDetailSchema>;
export type CommitSnapshot = z.infer<typeof CommitSnapshotSchema>;

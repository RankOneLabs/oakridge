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

import type { CellId, ConditionName, TargetName } from "../pwa/lib/ids";

// All wire schemas use ``z.strictObject`` rather than the default
// ``z.object``: in Zod v4, ``z.object`` strips unknown keys at parse
// time, which would let a new field added to store.ts pass silently
// to the wire and reach the PWA. The whole point of the boundary
// parse in server.ts is to *catch* that drift as a visible 500 —
// strict mode is what makes that work.

// ``cell_id`` / ``target_name`` / ``condition_name`` carry the brand
// types defined in pwa/lib/ids.ts (cohort 1's product). We don't use
// zod's ``.brand<>()`` because that produces a structurally distinct
// branded type that wouldn't be assignable to/from cohort 1's
// ``string & { readonly __brand: 'X' }`` pattern — every consumer
// would have to choose a side. ``.transform`` re-uses cohort 1's
// brand authoritatively: the runtime value is still a plain string;
// only the inferred TS type carries the brand.

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
  cell_id: z.string().transform((s): CellId => s as CellId),
  run_ts: z.string(),
  target_name: z.string().transform((s): TargetName => s as TargetName),
  condition_name: z
    .string()
    .transform((s): ConditionName => s as ConditionName),
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

// --- PWA UI state --------------------------------------------------------

// ``Tab`` doesn't cross the wire, but it's consumed in both App.tsx
// (state) and CellPanel.tsx (rendering). Putting the enum here keeps
// the "one shared definition" rule consistent across the codebase
// rather than carving out an exception for non-wire string unions.
export const TabSchema = z.enum(["events", "artifact", "commits", "scores"]);

// --- run spec schemas ----------------------------------------------------

export const TARGET_KEYS = [
  "prose_substrate_thesis",
  "code_leetcode_longest_substring",
  "code_leetcode_trapping_rain_water",
  "code_leetcode_regex_matching",
  "code_leetcode_median_two_sorted_arrays",
] as const;

export const CONDITION_KINDS = [
  "single_agent",
  "ensemble_single_round",
  "ensemble_multi_round",
  "ensemble_incremental",
] as const;

export const ConditionSpecSchema = z.strictObject({
  kind: z.enum(CONDITION_KINDS),
  n: z.number().int().min(1).max(16),
});

// Cross-field rules mirror run.py's ConditionSpec validation:
//   single_agent         => n must be 1
//   ensemble_single_round => n must be >= 2
//   ensemble_multi_round  => n must be >= 2
//   ensemble_incremental  => n must be >= 1 (already enforced by min(1))
export const RunSpecSchema = z
  .strictObject({
    target: z.enum(TARGET_KEYS),
    model_pool: z.array(z.string().min(1)).nonempty(),
    condition: ConditionSpecSchema,
    grade: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    const { kind, n } = val.condition;
    if (kind === "single_agent" && n !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["condition", "n"],
        message: "single_agent requires n === 1",
      });
    } else if (kind === "ensemble_single_round" && n < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["condition", "n"],
        message: "ensemble_single_round requires n >= 2",
      });
    } else if (kind === "ensemble_multi_round" && n < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["condition", "n"],
        message: "ensemble_multi_round requires n >= 2",
      });
    }
    // ensemble_incremental: n >= 1 is already enforced by min(1)
  });

export const RunStatusSchema = z.enum(["running", "exited", "failed"]);

export const RunSummarySchema = z.strictObject({
  runId: z.string(),
  run_ts: z.string(),
  cell_id: z.string().transform((s): CellId => s as CellId),
  target: z.enum(TARGET_KEYS),
  condition: ConditionSpecSchema,
  status: RunStatusSchema,
  started_ms: z.number(),
  exit_code: z.number().nullable(),
  stderr_tail: z.string(),
});

export const RunsResponseSchema = z.strictObject({
  runs: z.array(RunSummarySchema),
});

export const LaunchResponseSchema = z.strictObject({
  run_ts: z.string(),
  cell_id: z.string().transform((s): CellId => s as CellId),
  warning: z.string().optional(),
});

// --- conditionName helper -------------------------------------------------

// Reproduces cohort 1's canonical_condition_name: the condition segment
// of the on-disk directory path that run_cell creates. single_agent has
// no n-suffix; all ensemble kinds carry _n${n}.
export function conditionName(
  kind: (typeof CONDITION_KINDS)[number],
  n: number,
): ConditionName {
  if (kind === "single_agent") {
    return "single_agent" as ConditionName;
  }
  return `${kind}_n${n}` as ConditionName;
}

// --- inferred types ------------------------------------------------------

export type CellEvent = z.infer<typeof CellEventSchema>;
export type EvalScore = z.infer<typeof EvalScoreSchema>;
export type CellSummary = z.infer<typeof CellSummarySchema>;
export type CellDetail = z.infer<typeof CellDetailSchema>;
export type CommitSnapshot = z.infer<typeof CommitSnapshotSchema>;
export type Tab = z.infer<typeof TabSchema>;
export type ConditionSpec = z.infer<typeof ConditionSpecSchema>;
export type RunSpec = z.infer<typeof RunSpecSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type RunsResponse = z.infer<typeof RunsResponseSchema>;
export type LaunchResponse = z.infer<typeof LaunchResponseSchema>;

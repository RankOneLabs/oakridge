import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getCohort } from "../../db/cohorts";
import { taskTrackerEvents } from "../../db/events";
import {
  parsePrUrl,
  type PrState,
  type GhError,
  type Result,
} from "../../github/gh-gateway";
import { applyAwaitingMergeToMerged } from "./cohort-status";
import type { MergeBody, MergeOutcome } from "../../shared/cohort-merge-contract";

export type { MergeOutcome } from "../../shared/cohort-merge-contract";

export interface GhGateway {
  fetchPrState(prUrl: string): Promise<Result<PrState, GhError>>;
  mergePr(prUrl: string): Promise<Result<void, GhError>>;
}

const MergeBodySchema = z
  .object({
    confirm_unresolved: z.boolean().optional(),
    confirm_closed: z.boolean().optional(),
    confirm_threads_unknown: z.boolean().optional(),
  })
  .optional();

interface CohortMergeRouteDeps {
  db: Database;
  gh: GhGateway;
}

/** Returns true when the transition applied, false when the cohort was no longer awaiting_merge. */
function applyAndEmit(db: Database, cohort_id: string): boolean {
  const result = db.transaction(() => applyAwaitingMergeToMerged(db, cohort_id))();
  if (!result.emits) return false;
  taskTrackerEvents.emit("cohort.pr_merged", result.emits.pr_merged);
  taskTrackerEvents.emit("cohort.done", result.emits.done);
  for (const p of result.emits.buildReady) {
    taskTrackerEvents.emit("cohort.build_ready", p);
  }
  if (result.emits.planCompleted) {
    taskTrackerEvents.emit("plan.completed", result.emits.planCompleted);
  }
  return true;
}

export function mountCohortMergeRoutes(app: Hono, deps: CohortMergeRouteDeps): void {
  const { db, gh } = deps;

  app.post("/cohorts/:id/merge", async (c) => {
    let body: MergeBody = {};
    const rawText = await c.req.text();
    if (rawText.trim()) {
      let rawJson: unknown;
      try {
        rawJson = JSON.parse(rawText);
      } catch {
        return c.json({ error: "invalid json" }, 400);
      }
      const parsed = MergeBodySchema.safeParse(rawJson);
      if (!parsed.success) {
        return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400);
      }
      body = parsed.data ?? {};
    }

    const cohort_id = c.req.param("id");

    // Load cohort → 404
    const cohort = getCohort(db, cohort_id);
    if (!cohort) return c.json({ error: "not found" }, 404);

    // Idempotency: already done → already_done (no re-run of fanout)
    if (cohort.status === "done") {
      return c.json({ outcome: "already_done" } satisfies MergeOutcome);
    }

    // Must be awaiting_merge → 409
    if (cohort.status !== "awaiting_merge") {
      return c.json({ error: "merge only allowed from awaiting_merge status" }, 409);
    }

    // Load latest brief pr_url → 409 if missing
    const briefRow = db
      .prepare<{ pr_url: string | null }, [string]>(
        "SELECT pr_url FROM briefs WHERE cohort_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(cohort_id);
    if (!briefRow || !briefRow.pr_url) {
      return c.json({ error: "cohort has no brief with pr_url" }, 409);
    }
    const prUrl = briefRow.pr_url;

    // Parse pr_url → 422 on malformed
    const parsedUrl = parsePrUrl(prUrl);
    if (!parsedUrl.ok) {
      return c.json({ error: "malformed pr_url in brief", detail: prUrl }, 422);
    }

    // fetchPrState → 502 on gh errors
    const prStateResult = await gh.fetchPrState(prUrl);
    if (!prStateResult.ok) {
      const err = prStateResult.error;
      console.error(
        JSON.stringify({
          kbbl: "cohort-merge",
          error: err.kind,
          cohort_id,
          pr_url: prUrl,
        }),
      );
      return c.json({ error: "gh failed", detail: err }, 502);
    }

    const prState = prStateResult.value;
    const { confirm_unresolved, confirm_closed, confirm_threads_unknown } = body;

    console.log(
      JSON.stringify({
        kbbl: "cohort-merge",
        cohort_id,
        pr_url: prUrl,
        prState_kind: prState.kind,
        confirm_unresolved: confirm_unresolved ?? false,
        confirm_closed: confirm_closed ?? false,
        confirm_threads_unknown: confirm_threads_unknown ?? false,
      }),
    );

    if (prState.kind === "already_merged") {
      if (!applyAndEmit(db, cohort_id)) {
        const cur = getCohort(db, cohort_id);
        if (cur?.status === "done") return c.json({ outcome: "already_done" } satisfies MergeOutcome);
        return c.json({ error: "cohort status changed during merge" }, 409);
      }
      return c.json({
        outcome: "merged",
        via: "already_merged",
        merged_at: prState.mergedAt,
      } satisfies MergeOutcome);
    }

    if (prState.kind === "open_mergeable_clean") {
      const mergeResult = await gh.mergePr(prUrl);
      if (!mergeResult.ok) {
        return c.json({ error: "gh failed", detail: mergeResult.error }, 502);
      }
      if (!applyAndEmit(db, cohort_id)) {
        const cur = getCohort(db, cohort_id);
        if (cur?.status === "done") return c.json({ outcome: "already_done" } satisfies MergeOutcome);
        return c.json({ error: "cohort status changed during merge" }, 409);
      }
      return c.json({ outcome: "merged", via: "merged_now" } satisfies MergeOutcome);
    }

    if (prState.kind === "open_mergeable_unresolved") {
      if (!confirm_unresolved) {
        return c.json({
          outcome: "confirm_unresolved",
          threads: prState.threads,
        } satisfies MergeOutcome);
      }
      // Operator confirmed → proceed to merge
      const mergeResult = await gh.mergePr(prUrl);
      if (!mergeResult.ok) {
        return c.json({ error: "gh failed", detail: mergeResult.error }, 502);
      }
      if (!applyAndEmit(db, cohort_id)) {
        const cur = getCohort(db, cohort_id);
        if (cur?.status === "done") return c.json({ outcome: "already_done" } satisfies MergeOutcome);
        return c.json({ error: "cohort status changed during merge" }, 409);
      }
      return c.json({ outcome: "merged", via: "merged_now" } satisfies MergeOutcome);
    }

    if (prState.kind === "open_mergeable_threads_unknown") {
      if (!confirm_threads_unknown) {
        return c.json({ outcome: "confirm_threads_unknown" } satisfies MergeOutcome);
      }
      // Operator confirmed despite unknown thread state → proceed to merge.
      const mergeResult = await gh.mergePr(prUrl);
      if (!mergeResult.ok) {
        return c.json({ error: "gh failed", detail: mergeResult.error }, 502);
      }
      if (!applyAndEmit(db, cohort_id)) {
        const cur = getCohort(db, cohort_id);
        if (cur?.status === "done") return c.json({ outcome: "already_done" } satisfies MergeOutcome);
        return c.json({ error: "cohort status changed during merge" }, 409);
      }
      return c.json({ outcome: "merged", via: "merged_now" } satisfies MergeOutcome);
    }

    if (prState.kind === "open_not_mergeable") {
      return c.json({
        outcome: "not_mergeable",
        reason: prState.reason,
      } satisfies MergeOutcome);
    }

    // closed_unmerged
    if (!confirm_closed) {
      return c.json({ outcome: "confirm_closed" } satisfies MergeOutcome);
    }
    // Operator confirmed closed PR: mark done WITHOUT calling mergePr
    if (!applyAndEmit(db, cohort_id)) {
      const cur = getCohort(db, cohort_id);
      if (cur?.status === "done") return c.json({ outcome: "already_done" } satisfies MergeOutcome);
      return c.json({ error: "cohort status changed during merge" }, 409);
    }
    return c.json({
      outcome: "merged",
      via: "already_merged",
      merged_at: null,
    } satisfies MergeOutcome);
  });
}

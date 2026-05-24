import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getCohort } from "../../db/cohorts";
import { getLatestApprovedBriefByCohort } from "../../db/briefs";
import { taskTrackerEvents } from "../../db/events";
import type { Cohort } from "../../types/task-tracker";

const PatchCohortStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("blocked") }),
  z.object({ status: z.literal("unblocked") }),
  z.object({ status: z.literal("done") }),
  z.object({ status: z.literal("awaiting_merge"), pr_url: z.string().url() }),
  z.object({ status: z.literal("merged") }),
]);

interface PatchCohortStatusPayload {
  status: unknown;
}

interface CohortStatusRouteDeps {
  db: Database;
}

function hasStatusField(value: unknown): value is PatchCohortStatusPayload {
  return typeof value === "object" && value !== null && "status" in value;
}

interface DoneFanoutResult {
  buildReady: { cohort_id: string; brief_id: string }[];
}

function runDoneFanout(db: Database, cohort_id: string): DoneFanoutResult {
  const downstream = db
    .prepare<{ to_cohort_id: string }, [string]>(
      "SELECT to_cohort_id FROM cohort_dependencies WHERE from_cohort_id = ?",
    )
    .all(cohort_id);

  const buildReady: { cohort_id: string; brief_id: string }[] = [];

  for (const { to_cohort_id } of downstream) {
    const dep = getCohort(db, to_cohort_id);
    if (!dep) continue;

    const unmetDeps = db
      .prepare<{ cnt: number }, [string]>(
        `SELECT COUNT(*) AS cnt
         FROM cohort_dependencies cd
         JOIN cohorts c ON c.id = cd.from_cohort_id
         WHERE cd.to_cohort_id = ? AND c.status != 'done'`,
      )
      .get(to_cohort_id);

    // Advance ready_to_build dependents to building when their last dep resolves
    if (dep.status === "ready_to_build" && unmetDeps && unmetDeps.cnt === 0) {
      const brief = getLatestApprovedBriefByCohort(db, to_cohort_id);
      if (!brief) {
        console.error(
          JSON.stringify({ kbbl: "cohort-status", warn: "ready_to_build cohort has no approved brief", cohort_id: to_cohort_id }),
        );
      } else {
        db.prepare("UPDATE cohorts SET status = 'building' WHERE id = ?").run(to_cohort_id);
        buildReady.push({ cohort_id: to_cohort_id, brief_id: brief.id });
      }
    }
  }

  return { buildReady };
}

export interface ApplyAwaitingMergeResult {
  updated: Cohort;
  /** null when the cohort was already done — caller must skip event emission. */
  emits: {
    done: { cohort_id: string };
    pr_merged: { cohort_id: string };
    buildReady: { cohort_id: string; brief_id: string }[];
    planCompleted: { plan_id: string } | null;
  } | null;
}

/**
 * Applies the awaiting_merge → merged (done) transition and gathers all
 * events that must be emitted afterward. Caller is responsible for running
 * this inside a db.transaction and for emitting the returned events.
 * Returns emits=null when the cohort was already done (race no-op).
 */
export function applyAwaitingMergeToMerged(
  db: Database,
  cohort_id: string,
): ApplyAwaitingMergeResult {
  const { changes } = db
    .prepare("UPDATE cohorts SET status = 'done' WHERE id = ? AND status = 'awaiting_merge'")
    .run(cohort_id);
  const updated = getCohort(db, cohort_id)!;
  if (changes === 0) {
    return { updated, emits: null };
  }
  const fanout = runDoneFanout(db, cohort_id);
  const remaining = db
    .prepare<{ cnt: number }, [string]>(
      "SELECT COUNT(*) AS cnt FROM cohorts WHERE plan_id = ? AND status != 'done'",
    )
    .get(updated.plan_id);
  const planCompleted = remaining && remaining.cnt === 0 ? { plan_id: updated.plan_id } : null;
  return {
    updated,
    emits: {
      done: { cohort_id },
      pr_merged: { cohort_id },
      buildReady: fanout.buildReady,
      planCompleted,
    },
  };
}

// Statuses the orchestrator manages internally — operator cannot set them directly.
const ORCHESTRATOR_ONLY_STATUSES = new Set([
  "waiting", "planned", "briefing", "brief_review", "building", "ready_to_build",
]);

// Statuses the operator may set. Validation failure means bad payload, not wrong caller.
const OPERATOR_SETTABLE_STATUSES = new Set([
  "blocked", "unblocked", "done", "awaiting_merge", "merged",
]);

export function mountCohortStatusRoutes(app: Hono, deps: CohortStatusRouteDeps): void {
  const { db } = deps;

  app.patch("/cohorts/:id/status", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = PatchCohortStatusSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      const statusVal = hasStatusField(body) ? body.status : undefined;
      if (typeof statusVal === "string") {
        // Orchestrator-managed statuses are not operator-settable → wrong caller.
        if (ORCHESTRATOR_ONLY_STATUSES.has(statusVal)) {
          return c.json({ error: "transition is orchestrator-only" }, 422);
        }
        // Operator-settable status with malformed payload → surface the validation error.
        if (OPERATOR_SETTABLE_STATUSES.has(statusVal)) {
          return c.json({ error: msg }, 400);
        }
      }
      return c.json({ error: msg }, 400);
    }

    const parsed = result.data;
    const cohort_id = c.req.param("id");

    let updated: Cohort | null = null;
    let emitDone: { cohort_id: string } | null = null;
    let emitPrMerged: { cohort_id: string } | null = null;
    let emitPrOpened: { cohort_id: string; pr_url: string } | null = null;
    let emitPlanCompleted: { plan_id: string } | null = null;
    const emitBuildReady: { cohort_id: string; brief_id: string }[] = [];

    try {
      const error = db.transaction((): string | null => {
        const cohort = getCohort(db, cohort_id);
        if (!cohort) return "not_found";

        if (parsed.status === "blocked") {
          if (cohort.status === "blocked") return "already_blocked";
          db.prepare(
            "UPDATE cohorts SET status = 'blocked', pre_block_status = ? WHERE id = ?",
          ).run(cohort.status, cohort_id);
          updated = getCohort(db, cohort_id);
        } else if (parsed.status === "unblocked") {
          if (cohort.status !== "blocked") return "not_blocked";
          if (!cohort.pre_block_status) return "no_pre_block";
          db.prepare(
            "UPDATE cohorts SET status = ?, pre_block_status = NULL WHERE id = ?",
          ).run(cohort.pre_block_status, cohort_id);
          updated = getCohort(db, cohort_id);
        } else if (parsed.status === "done") {
          if (cohort.status !== "building") return "not_building";
          db.prepare("UPDATE cohorts SET status = 'done' WHERE id = ?").run(cohort_id);
          updated = getCohort(db, cohort_id);
          emitDone = { cohort_id };
          const fanout = runDoneFanout(db, cohort_id);
          emitBuildReady.push(...fanout.buildReady);
          const remaining = db
            .prepare<{ cnt: number }, [string]>(
              "SELECT COUNT(*) AS cnt FROM cohorts WHERE plan_id = ? AND status != 'done'",
            )
            .get(cohort.plan_id);
          if (remaining && remaining.cnt === 0) emitPlanCompleted = { plan_id: cohort.plan_id };
        } else if (parsed.status === "awaiting_merge") {
          if (cohort.status !== "building") return "not_building_for_await";
          db.prepare("UPDATE cohorts SET status = 'awaiting_merge' WHERE id = ?").run(cohort_id);
          db.prepare(
            `UPDATE briefs SET pr_url = COALESCE(pr_url, ?)
             WHERE id = (SELECT id FROM briefs WHERE cohort_id = ? ORDER BY created_at DESC, id DESC LIMIT 1)`,
          ).run(parsed.pr_url, cohort_id);
          updated = getCohort(db, cohort_id);
          emitPrOpened = { cohort_id, pr_url: parsed.pr_url };
        } else {
          // merged
          if (cohort.status !== "awaiting_merge") return "not_awaiting_merge";
          const result = applyAwaitingMergeToMerged(db, cohort_id);
          updated = result.updated;
          if (result.emits) {
            emitDone = result.emits.done;
            emitPrMerged = result.emits.pr_merged;
            emitBuildReady.push(...result.emits.buildReady);
            if (result.emits.planCompleted) emitPlanCompleted = result.emits.planCompleted;
          }
        }

        return null;
      })();

      if (error === "not_found") return c.json({ error: "not found" }, 404);
      if (error === "already_blocked") return c.json({ error: "cohort is already blocked" }, 409);
      if (error === "not_blocked") return c.json({ error: "cohort is not blocked" }, 409);
      if (error === "no_pre_block") return c.json({ error: "no pre_block_status recorded" }, 409);
      if (error === "not_building") return c.json({ error: "done transition only allowed from building" }, 409);
      if (error === "not_building_for_await") return c.json({ error: "awaiting_merge transition only allowed from building" }, 409);
      if (error === "not_awaiting_merge") return c.json({ error: "merged transition only allowed from awaiting_merge" }, 409);
    } catch (err) {
      console.error("cohort-status:patch failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    if (emitPrOpened) {
      taskTrackerEvents.emit("cohort.pr_opened", emitPrOpened);
    }
    if (emitPrMerged) {
      taskTrackerEvents.emit("cohort.pr_merged", emitPrMerged);
    }
    if (emitDone) {
      taskTrackerEvents.emit("cohort.done", emitDone);
      for (const p of emitBuildReady) {
        taskTrackerEvents.emit("cohort.build_ready", p);
      }
    }

    if (emitPlanCompleted) {
      taskTrackerEvents.emit("plan.completed", emitPlanCompleted);
    }

    return c.json(updated);
  });
}

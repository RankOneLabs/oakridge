import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getCohort } from "../../db/cohorts";
import { taskTrackerEvents } from "../../db/events";
import type { Cohort } from "../../types/task-tracker";

const PatchCohortStatusSchema = z.object({
  status: z.enum(["blocked", "unblocked", "done"]),
});

interface CohortStatusRouteDeps {
  db: Database;
}

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
      // A string status that is a real CohortStatus but not operator-settable
      // is an orchestrator-managed transition (e.g. "planned", "briefing").
      // A non-string, missing, or unrecognized status is bad input → 400.
      const FULL_COHORT_STATUSES = new Set([
        "waiting", "planned", "briefing", "brief_review", "building", "done", "blocked",
      ]);
      const statusVal =
        typeof body === "object" && body !== null && "status" in body
          ? (body as Record<string, unknown>).status
          : undefined;
      if (typeof statusVal === "string" && FULL_COHORT_STATUSES.has(statusVal)) {
        return c.json({ error: "transition is orchestrator-only" }, 422);
      }
      return c.json({ error: msg }, 400);
    }

    const { status: requestedStatus } = result.data;
    const cohort_id = c.req.param("id");

    let updated: Cohort | null = null;
    let emitDone: { cohort_id: string } | null = null;
    const emitPlanned: { cohort_id: string }[] = [];

    try {
      const error = db.transaction((): string | null => {
        const cohort = getCohort(db, cohort_id);
        if (!cohort) return "not_found";

        if (requestedStatus === "blocked") {
          if (cohort.status === "blocked") return "already_blocked";
          db.prepare(
            "UPDATE cohorts SET status = 'blocked', pre_block_status = ? WHERE id = ?",
          ).run(cohort.status, cohort_id);
          updated = getCohort(db, cohort_id);
        } else if (requestedStatus === "unblocked") {
          if (cohort.status !== "blocked") return "not_blocked";
          if (!cohort.pre_block_status) return "no_pre_block";
          db.prepare(
            "UPDATE cohorts SET status = ?, pre_block_status = NULL WHERE id = ?",
          ).run(cohort.pre_block_status, cohort_id);
          updated = getCohort(db, cohort_id);
        } else {
          // done
          if (cohort.status !== "building") return "not_building";
          db.prepare("UPDATE cohorts SET status = 'done' WHERE id = ?").run(cohort_id);
          updated = getCohort(db, cohort_id);
          emitDone = { cohort_id };

          // Auto-transition waiting dependents whose all prerequisites are now done
          const downstream = db
            .prepare<{ to_cohort_id: string }, [string]>(
              "SELECT to_cohort_id FROM cohort_dependencies WHERE from_cohort_id = ?",
            )
            .all(cohort_id);

          for (const { to_cohort_id } of downstream) {
            const dep = getCohort(db, to_cohort_id);
            if (!dep || dep.status !== "waiting") continue;

            const unmetDeps = db
              .prepare<{ cnt: number }, [string]>(
                `SELECT COUNT(*) AS cnt
                 FROM cohort_dependencies cd
                 JOIN cohorts c ON c.id = cd.from_cohort_id
                 WHERE cd.to_cohort_id = ? AND c.status != 'done'`,
              )
              .get(to_cohort_id);

            if (unmetDeps && unmetDeps.cnt === 0) {
              db.prepare("UPDATE cohorts SET status = 'planned' WHERE id = ?").run(to_cohort_id);
              emitPlanned.push({ cohort_id: to_cohort_id });
            }
          }
        }

        return null;
      })();

      if (error === "not_found") return c.json({ error: "not found" }, 404);
      if (error === "already_blocked") return c.json({ error: "cohort is already blocked" }, 409);
      if (error === "not_blocked") return c.json({ error: "cohort is not blocked" }, 409);
      if (error === "no_pre_block") return c.json({ error: "no pre_block_status recorded" }, 409);
      if (error === "not_building") return c.json({ error: "done transition only allowed from building" }, 409);
    } catch (err) {
      console.error("cohort-status:patch failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    if (emitDone) {
      taskTrackerEvents.emit("cohort.done", emitDone);
      for (const p of emitPlanned) {
        taskTrackerEvents.emit("cohort.entered_planned", p);
      }
    }

    return c.json(updated);
  });
}

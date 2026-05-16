import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getPlan } from "../../db/plans";
import { freeze } from "../../review/freeze";
import { taskTrackerEvents } from "../../db/events";
import { PLAN_TRANSITIONS } from "../../orchestrator/state-machine";
import type { Plan, Cohort } from "../../types/task-tracker";

const PatchPlanStatusSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  reason: z.string().optional(),
});

interface PlanStatusRouteDeps {
  db: Database;
}

export function mountPlanStatusRoutes(app: Hono, deps: PlanStatusRouteDeps): void {
  const { db } = deps;

  app.patch("/plans/:id/status", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = PatchPlanStatusSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { status: requestedStatus, reason } = result.data;
    const plan_id = c.req.param("id");

    let updated: Plan | null = null;
    let emitApproved: { plan_id: string; spec_id: string } | null = null;
    let emitRejected: { plan_id: string; spec_id: string } | null = null;
    const emitPlanned: { cohort_id: string }[] = [];

    try {
      const error = db.transaction((): string | null => {
        const plan = getPlan(db, plan_id);
        if (!plan) return "not_found";
        if (plan.status !== "pending_approval") return "not_pending";

        const event = requestedStatus === "approved" ? "approve" : "reject";
        const nextStatus = PLAN_TRANSITIONS[plan.status]?.[event];
        if (!nextStatus) return "no_transition";

        if (requestedStatus === "approved") {
          db.prepare<Plan, [string, string]>(
            "UPDATE plans SET status = ? WHERE id = ? RETURNING *",
          ).get(nextStatus, plan_id);
          freeze(db, "plan", plan_id);

          // Transition spec plan_review → planning_done
          db.prepare(
            "UPDATE specs SET status = 'planning_done' WHERE id = ? AND status = 'plan_review'",
          ).run(plan.spec_id);

          // Promote leaf cohorts (no inbound dependencies) waiting → planned
          const leafCohorts = db
            .prepare<Cohort, [string]>(
              `SELECT c.* FROM cohorts c
               WHERE c.plan_id = ?
                 AND c.status = 'waiting'
                 AND NOT EXISTS (
                   SELECT 1 FROM cohort_dependencies cd WHERE cd.to_cohort_id = c.id
                 )`,
            )
            .all(plan_id);

          for (const cohort of leafCohorts) {
            db.prepare("UPDATE cohorts SET status = 'planned' WHERE id = ?").run(cohort.id);
            emitPlanned.push({ cohort_id: cohort.id });
          }

          updated = getPlan(db, plan_id);
          emitApproved = { plan_id, spec_id: plan.spec_id };
        } else {
          db.prepare(
            "UPDATE plans SET status = ?, rejection_reason = ? WHERE id = ?",
          ).run(nextStatus, reason ?? null, plan_id);
          updated = getPlan(db, plan_id);
          emitRejected = { plan_id, spec_id: plan.spec_id };
        }

        return null;
      })();

      if (error === "not_found") return c.json({ error: "not found" }, 404);
      if (error === "not_pending") return c.json({ error: "plan is not in pending_approval" }, 409);
      if (error === "no_transition") return c.json({ error: "transition not defined" }, 409);
    } catch (err) {
      console.error("plan-status:patch failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    // Emit events after transaction commits (open question 2b resolution)
    if (emitApproved) {
      taskTrackerEvents.emit("plan.approved", emitApproved);
      for (const p of emitPlanned) {
        taskTrackerEvents.emit("cohort.entered_planned", p);
      }
    }
    if (emitRejected) {
      taskTrackerEvents.emit("plan.rejected", emitRejected);
    }

    return c.json(updated);
  });
}

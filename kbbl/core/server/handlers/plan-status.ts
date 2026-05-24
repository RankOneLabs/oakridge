import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getPlan } from "../../db/plans";
import { freeze } from "../../review/freeze";
import { taskTrackerEvents } from "../../db/events";
import { PLAN_TRANSITIONS } from "../../orchestrator/state-machine";
import type { Plan } from "../../types/task-tracker";

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
    if (requestedStatus === "rejected" && !reason?.trim()) {
      return c.json({ error: "reason is required when rejecting a plan" }, 400);
    }
    const plan_id = c.req.param("id");

    let updated: Plan | null = null;
    let emitApproved: { plan_id: string; spec_id: string } | null = null;
    let emitRejected: { plan_id: string; spec_id: string } | null = null;
    const emitBriefingStarted: { cohort_id: string }[] = [];

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

          // Promote all waiting cohorts directly to briefing
          const waitingCohorts = db
            .prepare<{ id: string }, [string]>(
              "SELECT id FROM cohorts WHERE plan_id = ? AND status = 'waiting'",
            )
            .all(plan_id);

          for (const cohort of waitingCohorts) {
            db.prepare("UPDATE cohorts SET status = 'briefing' WHERE id = ?").run(cohort.id);
            emitBriefingStarted.push({ cohort_id: cohort.id });
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

    if (emitApproved) {
      taskTrackerEvents.emit("plan.approved", emitApproved);
      for (const p of emitBriefingStarted) {
        taskTrackerEvents.emit("cohort.briefing_started", p);
      }
    }
    if (emitRejected) {
      taskTrackerEvents.emit("plan.rejected", emitRejected);
    }

    return c.json(updated);
  });
}

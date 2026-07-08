import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getPlan } from "../../db/plans";
import { freeze } from "../../review/freeze";
import { emitFreezeEvents, type ReviewFreezeEvent } from "../../review/events";
import { taskTrackerEvents } from "../../db/events";
import { PLAN_TRANSITIONS } from "../../orchestrator/state-machine";
import { getEpicBySpec, advanceEpicByEvent } from "../../db/epics";
import { isFrozen } from "../../db/epic-freeze";
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

  // The plan_writer agent creates a plan in 'draft', posts every cohort and
  // dependency, then submits it for review. Submitting is the signal that the
  // plan is complete; only then does it enter 'pending_approval' and become
  // visible/approvable in the PWA. This is what prevents the operator from
  // approving a half-written plan.
  app.post("/plans/:id/submit", async (c) => {
    const plan_id = c.req.param("id");

    const planForFreeze = db
      .prepare<{ spec_id: string }, [string]>("SELECT spec_id FROM plans WHERE id = ?")
      .get(plan_id);
    if (planForFreeze) {
      const epic = getEpicBySpec(db, planForFreeze.spec_id);
      if (epic && isFrozen(db, epic.id)) {
        return c.json({ error: "epic is archived" }, 409);
      }
    }

    let updated: Plan | null = null;
    try {
      const error = db.transaction((): string | null => {
        const plan = getPlan(db, plan_id);
        if (!plan) return "not_found";
        if (plan.status !== "draft") return "not_draft";

        const nextStatus = PLAN_TRANSITIONS[plan.status]?.submit;
        if (!nextStatus) return "no_transition";

        const cohortCount = db
          .prepare<{ cnt: number }, [string]>(
            "SELECT COUNT(*) AS cnt FROM cohorts WHERE plan_id = ?",
          )
          .get(plan_id);
        if (!cohortCount || cohortCount.cnt === 0) return "no_cohorts";

        db.prepare("UPDATE plans SET status = ? WHERE id = ?").run(nextStatus, plan_id);
        updated = getPlan(db, plan_id);
        return null;
      })();

      if (error === "not_found") return c.json({ error: "not found" }, 404);
      if (error === "not_draft") return c.json({ error: "plan is not in draft" }, 409);
      if (error === "no_transition") return c.json({ error: "transition not defined" }, 409);
      if (error === "no_cohorts")
        return c.json({ error: "plan must have at least one cohort before it can be submitted" }, 409);
    } catch (err) {
      console.error("plan-status:submit failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    // updated is only null if the row vanished between UPDATE and re-read;
    // never respond 200 with a null body.
    if (!updated) return c.json({ error: "internal server error" }, 500);
    return c.json(updated);
  });

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

    const planForFreeze = db
      .prepare<{ spec_id: string }, [string]>("SELECT spec_id FROM plans WHERE id = ?")
      .get(plan_id);
    if (planForFreeze) {
      const epic = getEpicBySpec(db, planForFreeze.spec_id);
      if (epic && isFrozen(db, epic.id)) {
        return c.json({ error: "epic is archived" }, 409);
      }
    }

    let updated: Plan | null = null;
    let emitApproved: { plan_id: string; spec_id: string } | null = null;
    let emitRejected: { plan_id: string; spec_id: string } | null = null;
    const emitBriefingStarted: { cohort_id: string }[] = [];
    let pendingFreezeEvents: ReviewFreezeEvent[] = [];

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
          pendingFreezeEvents = freeze(db, "plan", plan_id);

          // Advance Epic stage: plan → build
          const epic = getEpicBySpec(db, plan.spec_id);
          if (epic) {
            try {
              advanceEpicByEvent(db, epic.id, "epic_plan_approved");
            } catch (err) {
              console.error(
                JSON.stringify({ kbbl: "plan-status", warn: "advanceEpicByEvent failed", error: String(err), plan_id }),
              );
            }
          }

          // specs.status dropped in migration 016; Epic.status + internal_status cover lifecycle.

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
      pendingFreezeEvents = [];
      console.error("plan-status:patch failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    // updated is only null if the row vanished between UPDATE and re-read;
    // never emit events or respond 200 with a null body.
    if (!updated) return c.json({ error: "internal server error" }, 500);

    emitFreezeEvents(pendingFreezeEvents);
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

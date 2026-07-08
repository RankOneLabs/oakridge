import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getBrief, insertBrief } from "../../db/briefs";
import { transitionCohort, type CohortTransitionResult } from "../../db/cohort-transitions";
import { freeze, unfreeze } from "../../review/freeze";
import { emitFreezeEvents, type ReviewFreezeEvent } from "../../review/events";
import { taskTrackerEvents } from "../../db/events";
import { BRIEF_TRANSITIONS } from "../../orchestrator/state-machine";
import { isBriefEpicArchived } from "../../db/archive-guards";
import { countUnmetDependencies } from "../../db/cohorts";
import type { Brief } from "../../types/task-tracker";

const PatchBriefStatusSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  reason: z.string().optional(),
});

const BriefReopenSchema = z.object({
  model: z.string().optional(),
});

interface BriefStatusRouteDeps {
  db: Database;
}

type FailedCohortTransition = Extract<CohortTransitionResult, { ok: false }>;

export function mountBriefStatusRoutes(app: Hono, deps: BriefStatusRouteDeps): void {
  const { db } = deps;

  app.patch("/briefs/:id/status", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = PatchBriefStatusSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { status: requestedStatus, reason } = result.data;
    if (requestedStatus === "rejected" && !reason?.trim()) {
      return c.json({ error: "reason is required when rejecting a brief" }, 400);
    }
    const brief_id = c.req.param("id");

    if (isBriefEpicArchived(db, brief_id)) {
      return c.json({ error: "epic is archived" }, 409);
    }

    let updated: Brief | null = null;
    let emitApproved: { brief_id: string; cohort_id: string } | null = null;
    let emitRejected: { brief_id: string; cohort_id: string } | null = null;
    let depsMet = false;
    let pendingFreezeEvents: ReviewFreezeEvent[] = [];
    let cohortTransitionError = undefined as FailedCohortTransition | undefined;

    try {
      const error = db.transaction((): string | null => {
        const brief = getBrief(db, brief_id);
        if (!brief) return "not_found";
        if (brief.status !== "pending_approval") return "not_pending";

        const event = requestedStatus === "approved" ? "approve" : "reject";
        const nextStatus = BRIEF_TRANSITIONS[brief.status]?.[event];
        if (!nextStatus) return "no_transition";

        if (requestedStatus === "approved") {
          const nextCohortStatus =
            countUnmetDependencies(db, brief.cohort_id) > 0 ? "ready_to_build" : "building";
          depsMet = nextCohortStatus === "building";
          const cohortEvent = depsMet ? "brief_approved_deps_met" : "brief_approved_deps_pending";

          const cohortTransition = transitionCohort(db, brief.cohort_id, cohortEvent);
          if (!cohortTransition.ok) {
            cohortTransitionError = cohortTransition;
            return "cohort_transition_failed";
          }
          db.prepare("UPDATE briefs SET status = ? WHERE id = ?").run(nextStatus, brief_id);
          pendingFreezeEvents = freeze(db, "build_brief", brief_id);
          updated = getBrief(db, brief_id);
          emitApproved = { brief_id, cohort_id: brief.cohort_id };
        } else {
          const cohortTransition = transitionCohort(db, brief.cohort_id, "brief_rejected");
          if (!cohortTransition.ok) {
            cohortTransitionError = cohortTransition;
            return "cohort_transition_failed";
          }
          db.prepare(
            "UPDATE briefs SET status = ?, rejection_reason = ? WHERE id = ?",
          ).run(nextStatus, reason ?? null, brief_id);
          updated = getBrief(db, brief_id);
          emitRejected = { brief_id, cohort_id: brief.cohort_id };
        }

        return null;
      })();

      if (error === "not_found") return c.json({ error: "not found" }, 404);
      if (error === "not_pending") return c.json({ error: "brief is not in pending_approval" }, 409);
      if (error === "no_transition") return c.json({ error: "transition not defined" }, 409);
      if (error === "cohort_transition_failed") {
        if (cohortTransitionError?.reason === "not_found") {
          return c.json({ error: "cohort not found", detail: cohortTransitionError.detail }, 404);
        }
        if (cohortTransitionError?.reason === "invalid_transition") {
          return c.json({
            error: cohortTransitionError.detail,
            current_status: cohortTransitionError.current,
            requested: cohortTransitionError.event,
          }, 409);
        }
        return c.json({ error: "cohort transition failed" }, 409);
      }
    } catch (err) {
      pendingFreezeEvents = [];
      console.error("brief-status:patch failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    emitFreezeEvents(pendingFreezeEvents);
    if (emitApproved) {
      const { cohort_id: approvedCohortId } = emitApproved;
      taskTrackerEvents.emit("brief.approved", emitApproved);
      if (depsMet) {
        taskTrackerEvents.emit("cohort.build_ready", { cohort_id: approvedCohortId, brief_id });
      }
    }
    if (emitRejected) taskTrackerEvents.emit("brief.rejected", emitRejected);

    return c.json(updated);
  });

  app.post("/briefs/:id/reopen", async (c) => {
    let body: unknown;
    try {
      const text = await c.req.text();
      body = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = BriefReopenSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { model } = result.data;
    const old_id = c.req.param("id");

    if (isBriefEpicArchived(db, old_id)) {
      return c.json({ error: "epic is archived" }, 409);
    }

    let newBrief: Brief | null = null;
    let pendingReopenEvents: ReviewFreezeEvent[] = [];

    try {
      const error = db.transaction((): string | null => {
        const oldBrief = getBrief(db, old_id);
        if (!oldBrief) return "not_found";
        if (oldBrief.status !== "approved" && oldBrief.status !== "rejected") return "not_reopenable";

        const new_id = crypto.randomUUID();
        newBrief = insertBrief(db, {
          id: new_id,
          cohort_id: oldBrief.cohort_id,
          model: model ?? oldBrief.model ?? null,
          predecessor_brief_id: old_id,
          goal: oldBrief.goal,
          files_in_scope: oldBrief.files_in_scope,
          decisions_made: oldBrief.decisions_made,
          approaches_rejected: oldBrief.approaches_rejected,
          next_action: oldBrief.next_action,
        });

        pendingReopenEvents = unfreeze(db, "build_brief", old_id);
        db.prepare("UPDATE briefs SET status = 'superseded' WHERE id = ?").run(old_id);
        // Cohort status intentionally unchanged (operator drives re-trigger)

        return null;
      })();

      if (error === "not_found") return c.json({ error: "not found" }, 404);
      if (error === "not_reopenable") return c.json({ error: "brief must be in approved or rejected to reopen" }, 409);
    } catch (err) {
      pendingReopenEvents = [];
      console.error("brief-reopen:post failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    emitFreezeEvents(pendingReopenEvents);
    if (newBrief) {
      taskTrackerEvents.emit("brief.submitted", {
        brief_id: (newBrief as Brief).id,
        cohort_id: (newBrief as Brief).cohort_id,
      });
    }

    return c.json(newBrief, 201);
  });
}

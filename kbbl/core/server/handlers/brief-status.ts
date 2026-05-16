import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getBrief, insertBrief } from "../../db/briefs";
import { freeze, unfreeze } from "../../review/freeze";
import { taskTrackerEvents } from "../../db/events";
import { BRIEF_TRANSITIONS } from "../../orchestrator/state-machine";
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

    let updated: Brief | null = null;
    let emitApproved: { brief_id: string; cohort_id: string } | null = null;
    let emitRejected: { brief_id: string; cohort_id: string } | null = null;

    try {
      const error = db.transaction((): string | null => {
        const brief = getBrief(db, brief_id);
        if (!brief) return "not_found";
        if (brief.status !== "pending_approval") return "not_pending";

        const event = requestedStatus === "approved" ? "approve" : "reject";
        const nextStatus = BRIEF_TRANSITIONS[brief.status]?.[event];
        if (!nextStatus) return "no_transition";

        if (requestedStatus === "approved") {
          const cohortResult = db.prepare(
            "UPDATE cohorts SET status = 'building' WHERE id = ? AND status = 'brief_review'",
          ).run(brief.cohort_id);
          if (cohortResult.changes === 0) return "cohort_not_in_brief_review";
          db.prepare("UPDATE briefs SET status = ? WHERE id = ?").run(nextStatus, brief_id);
          freeze(db, "build_brief", brief_id);
          updated = getBrief(db, brief_id);
          emitApproved = { brief_id, cohort_id: brief.cohort_id };
        } else {
          const cohortResult = db.prepare(
            "UPDATE cohorts SET status = 'briefing' WHERE id = ? AND status = 'brief_review'",
          ).run(brief.cohort_id);
          if (cohortResult.changes === 0) return "cohort_not_in_brief_review";
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
      if (error === "cohort_not_in_brief_review") return c.json({ error: "cohort is not in brief_review" }, 409);
    } catch (err) {
      console.error("brief-status:patch failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    if (emitApproved) taskTrackerEvents.emit("brief.approved", emitApproved);
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

    let newBrief: Brief | null = null;

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

        unfreeze(db, "build_brief", old_id);
        db.prepare("UPDATE briefs SET status = 'superseded' WHERE id = ?").run(old_id);
        // Cohort status intentionally unchanged (operator drives re-trigger)

        return null;
      })();

      if (error === "not_found") return c.json({ error: "not found" }, 404);
      if (error === "not_reopenable") return c.json({ error: "brief must be in approved or rejected to reopen" }, 409);
    } catch (err) {
      console.error("brief-reopen:post failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    if (newBrief) {
      taskTrackerEvents.emit("brief.submitted", {
        brief_id: (newBrief as Brief).id,
        cohort_id: (newBrief as Brief).cohort_id,
      });
    }

    return c.json(newBrief, 201);
  });
}

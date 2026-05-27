import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getEpic, listEpicsByProject, advanceEpicByEvent } from "../../db/epics";
import { taskTrackerEvents } from "../../db/events";
import type { EpicStatus } from "../../types/task-tracker";

const PatchEpicStatusSchema = z.object({
  status: z.enum(["archived", "pending"]),
});

interface EpicsRouteDeps {
  db: Database;
}

export function mountEpicsRoutes(app: Hono, deps: EpicsRouteDeps): void {
  const { db } = deps;

  // GET /epics?project_id=...&status=...
  app.get("/epics", (c) => {
    const project_id = c.req.query("project_id");
    if (!project_id) {
      return c.json({ error: "project_id query param required" }, 400);
    }
    const statusFilter = c.req.query("status") as EpicStatus | undefined;
    if (statusFilter !== undefined) {
      const validStatuses: EpicStatus[] = ["pending", "active", "complete", "archived"];
      if (!validStatuses.includes(statusFilter)) {
        return c.json({ error: "invalid status value" }, 400);
      }
    }
    return c.json(listEpicsByProject(db, project_id, statusFilter));
  });

  // GET /epics/:id — detail view with spec, latest plan, cohort snapshot, assessment_present
  app.get("/epics/:id", (c) => {
    const id = c.req.param("id");
    const epic = getEpic(db, id);
    if (!epic) {
      return c.json({ error: "not found" }, 404);
    }

    const spec = db
      .prepare<{ id: string; title: string; internal_status: string }, [string]>(
        "SELECT id, title, internal_status FROM specs WHERE id = ?",
      )
      .get(epic.spec_id);

    const plan = db
      .prepare<{ id: string; status: string } | null, [string]>(
        "SELECT id, status FROM plans WHERE spec_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(epic.spec_id) ?? null;

    const cohorts = plan
      ? db
          .prepare<{ id: string; title: string; status: string }, [string]>(
            "SELECT id, title, status FROM cohorts WHERE plan_id = ? ORDER BY position, id",
          )
          .all(plan.id)
      : [];

    const cohort_count = cohorts.length;

    const assessment_present = plan
      ? (db
            .prepare<{ cnt: number }, [string]>(
              "SELECT COUNT(*) AS cnt FROM assessments WHERE plan_id = ?",
            )
            .get(plan.id)?.cnt ?? 0) > 0
      : false;

    return c.json({
      epic,
      spec: spec ?? null,
      plan: plan ?? null,
      cohorts,
      cohort_count,
      assessment_present,
    });
  });

  // PATCH /epics/:id/status — archive or unarchive; lifecycle transitions are
  // operator-only here. State-machine transitions (active, complete) are driven
  // by artifact events and cannot be set directly to avoid racing the event path.
  //
  // Archive does NOT auto-kill running sessions; stop them via DELETE /sessions/:sid.
  app.patch("/epics/:id/status", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = PatchEpicStatusSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { status: requestedStatus } = result.data;
    const id = c.req.param("id");

    const event = requestedStatus === "archived" ? "archive" : "unarchive";

    let emitArchived: { epic_id: string } | null = null;
    let emitUnarchived: { epic_id: string } | null = null;

    let errorCode: string | null = null;
    let updated = null;
    try {
      errorCode = db.transaction((): string | null => {
        const epic = getEpic(db, id);
        if (!epic) return "not_found";

        if (requestedStatus === "archived" && epic.status === "archived") return "already_archived";
        if (requestedStatus === "pending" && epic.status !== "archived") return "not_archived";

        const next = advanceEpicByEvent(db, id, event);
        if (!next) return "not_found";
        updated = next;

        if (requestedStatus === "archived") emitArchived = { epic_id: id };
        else emitUnarchived = { epic_id: id };

        return null;
      })();
    } catch (err) {
      console.error("epics:patch-status failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    if (errorCode === "not_found") return c.json({ error: "not found" }, 404);
    if (errorCode === "already_archived") return c.json({ error: "epic is already archived" }, 409);
    if (errorCode === "not_archived") return c.json({ error: "epic is not archived; cannot unarchive" }, 409);

    if (emitArchived) taskTrackerEvents.emit("epic.archived", emitArchived);
    if (emitUnarchived) taskTrackerEvents.emit("epic.unarchived", emitUnarchived);

    return c.json(updated);
  });

  // DELETE /epics/:id — transactional cascade deletes all SQL rows; JSONL
  // transcripts are left untouched (they are the audit trail, keyed by
  // session_ref outside this entity tree).
  app.delete("/epics/:id", (c) => {
    const id = c.req.param("id");

    let errorCode: string | null = null;
    try {
      errorCode = db.transaction((): string | null => {
        const epic = getEpic(db, id);
        if (!epic) return "not_found";

        const spec_id = epic.spec_id;

        // Collect plan IDs for this spec so we can cascade through cohorts
        const planIds = db
          .prepare<{ id: string }, [string]>("SELECT id FROM plans WHERE spec_id = ?")
          .all(spec_id)
          .map((r) => r.id);

        const cohortIds = planIds.length > 0
          ? db
              .prepare<{ id: string }, string[]>(
                `SELECT id FROM cohorts WHERE plan_id IN (${planIds.map(() => "?").join(",")})`,
              )
              .all(...planIds)
              .map((r) => r.id)
          : [];

        // Ordered cascade: deepest FK dependencies first
        if (cohortIds.length > 0) {
          const ph = cohortIds.map(() => "?").join(",");
          db.prepare(`DELETE FROM briefs WHERE cohort_id IN (${ph})`).run(...cohortIds);
          db.prepare(`DELETE FROM cohort_dependencies WHERE from_cohort_id IN (${ph}) OR to_cohort_id IN (${ph})`).run(...cohortIds, ...cohortIds);
          db.prepare(`DELETE FROM cohorts WHERE id IN (${ph})`).run(...cohortIds);
        }

        if (planIds.length > 0) {
          const ph = planIds.map(() => "?").join(",");
          db.prepare(`DELETE FROM assessments WHERE plan_id IN (${ph})`).run(...planIds);
          db.prepare(`DELETE FROM plans WHERE id IN (${ph})`).run(...planIds);
        }

        db.prepare("DELETE FROM spec_discrepancies WHERE spec_id = ?").run(spec_id);
        // epics.spec_id → specs.id: delete epic before spec to satisfy FK constraint
        db.prepare("DELETE FROM epics WHERE id = ?").run(id);
        db.prepare("DELETE FROM specs WHERE id = ?").run(spec_id);

        return null;
      })();
    } catch (err) {
      console.error("epics:delete failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    if (errorCode === "not_found") return c.json({ error: "not found" }, 404);

    return new Response(null, { status: 204 });
  });
}

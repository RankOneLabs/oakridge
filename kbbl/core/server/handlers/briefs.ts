import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  insertBrief,
  getBrief,
  listBriefsByCohort,
  updateBriefFields,
  updateBriefDebrief,
} from "../../db/briefs";
import { BriefPayloadSchema } from "../../types/task-tracker";
import { taskTrackerEvents } from "../../db/events";

const CreateBriefSchema = BriefPayloadSchema.extend({
  cohort_id: z.string().min(1),
  goal: z.string().min(1),
  next_action: z.string(),
  model: z.string().optional(),
});

const PatchBriefSchema = z.object({
  goal: z.string().min(1).optional(),
  files_in_scope: z.array(z.string()).optional(),
  decisions_made: z
    .array(z.object({ decision: z.string(), rationale: z.string() }))
    .optional(),
  approaches_rejected: z
    .array(z.object({ approach: z.string(), reason: z.string() }))
    .optional(),
  next_action: z.string().optional(),
  model: z.string().nullable().optional(),
});

const PatchDebriefSchema = z.object({
  debrief: z.string(),
});

interface BriefsRouteDeps {
  db: Database;
}

export function mountBriefsRoutes(app: Hono, deps: BriefsRouteDeps): void {
  const { db } = deps;

  app.get("/briefs", (c) => {
    const cohort_id = c.req.query("cohort_id");
    if (!cohort_id) {
      return c.json({ error: "cohort_id query param required" }, 400);
    }
    return c.json(listBriefsByCohort(db, cohort_id));
  });

  app.post("/briefs", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = CreateBriefSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const {
      cohort_id,
      goal,
      files_in_scope,
      decisions_made,
      approaches_rejected,
      next_action,
      model,
    } = result.data;
    const id = crypto.randomUUID();

    try {
      const brief = insertBrief(db, {
        id,
        cohort_id,
        goal,
        files_in_scope,
        decisions_made,
        approaches_rejected,
        next_action,
        model: model ?? null,
        predecessor_brief_id: null,
      });
      taskTrackerEvents.emit("brief.submitted", { brief_id: id, cohort_id });
      return c.json(brief, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("FOREIGN KEY constraint failed")) {
        return c.json({ error: "cohort not found" }, 404);
      }
      console.error("briefs:create failed", err);
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.get("/briefs/:id", (c) => {
    const id = c.req.param("id");
    const brief = getBrief(db, id);
    if (!brief) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(brief);
  });

  app.patch("/briefs/:id", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    if (typeof body === "object" && body !== null) {
      if ("status" in body) {
        return c.json(
          { error: "status not editable via PATCH /briefs/:id; use PATCH /briefs/:id/status" },
          400,
        );
      }
      if ("debrief" in body) {
        return c.json(
          { error: "debrief not editable via PATCH /briefs/:id; use PATCH /briefs/:id/debrief" },
          400,
        );
      }
    }

    const result = PatchBriefSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    if (Object.keys(result.data).length === 0) {
      return c.json({ error: "at least one mutable field is required" }, 400);
    }

    const id = c.req.param("id");
    const updated = updateBriefFields(db, id, result.data);
    if (!updated) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(updated);
  });

  app.patch("/briefs/:id/debrief", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = PatchDebriefSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const id = c.req.param("id");
    const updated = updateBriefDebrief(db, id, result.data.debrief);
    if (!updated) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(updated);
  });
}

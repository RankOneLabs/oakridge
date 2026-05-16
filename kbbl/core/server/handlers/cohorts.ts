import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  insertCohort,
  getCohort,
  listCohortsByPlan,
  updateCohortFields,
  insertCohortDependency,
  listDependenciesByPlan,
  deleteCohortDependency,
} from "../../db/cohorts";
import { hasCycleAfterInsert } from "../../db/cohort-graph";
import type { Cohort } from "../../types/task-tracker";

const CreateCohortSchema = z.object({
  plan_id: z.string().min(1),
  title: z.string().min(1),
  notes: z.string().optional(),
  position: z.number().int(),
});

const PatchCohortSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  position: z.number().int().optional(),
});

const CreateDependencySchema = z.object({
  from_cohort_id: z.string().min(1),
  to_cohort_id: z.string().min(1),
});

interface CohortsRouteDeps {
  db: Database;
}

export function mountCohortsRoutes(app: Hono, deps: CohortsRouteDeps): void {
  const { db } = deps;

  app.get("/cohorts", (c) => {
    const plan_id = c.req.query("plan_id");
    if (!plan_id) {
      return c.json({ error: "plan_id query param required" }, 400);
    }
    return c.json(listCohortsByPlan(db, plan_id));
  });

  app.post("/cohorts", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = CreateCohortSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { plan_id, title, notes, position } = result.data;
    const id = crypto.randomUUID();

    try {
      const cohort = insertCohort(db, { id, plan_id, title, notes: notes ?? null, position });
      return c.json(cohort, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("FOREIGN KEY constraint failed")) {
        return c.json({ error: "plan not found" }, 404);
      }
      console.error("cohorts:create failed", err);
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.get("/cohorts/:id", (c) => {
    const id = c.req.param("id");
    const cohort = getCohort(db, id);
    if (!cohort) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(cohort);
  });

  app.patch("/cohorts/:id", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    if (typeof body === "object" && body !== null && "status" in body) {
      return c.json(
        { error: "status not editable via PATCH /cohorts/:id; use PATCH /cohorts/:id/status" },
        400,
      );
    }

    const result = PatchCohortSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    if (Object.keys(result.data).length === 0) {
      return c.json({ error: "at least one mutable field is required" }, 400);
    }

    const id = c.req.param("id");
    const updated = updateCohortFields(db, id, result.data);
    if (!updated) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(updated);
  });

  app.get("/plans/:id/cohort-dependencies", (c) => {
    const plan_id = c.req.param("id");
    return c.json(listDependenciesByPlan(db, plan_id));
  });

  app.post("/cohort-dependencies", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = CreateDependencySchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { from_cohort_id, to_cohort_id } = result.data;

    const fromCohort = getCohort(db, from_cohort_id) as Cohort | null;
    const toCohort = getCohort(db, to_cohort_id) as Cohort | null;

    if (!fromCohort || !toCohort) {
      return c.json({ error: "cohort not found" }, 404);
    }

    if (fromCohort.plan_id !== toCohort.plan_id) {
      return c.json({ error: "cohorts must belong to the same plan" }, 409);
    }

    if (from_cohort_id === to_cohort_id) {
      return c.json({ error: "from_cohort_id and to_cohort_id must differ" }, 409);
    }

    const id = crypto.randomUUID();
    try {
      const dep = db.transaction(() => {
        if (hasCycleAfterInsert(db, from_cohort_id, to_cohort_id)) {
          return null;
        }
        return insertCohortDependency(db, { id, from_cohort_id, to_cohort_id });
      })();
      if (!dep) {
        return c.json({ error: "cycle" }, 409);
      }
      return c.json(dep, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed")) {
        return c.json({ error: "dependency already exists" }, 409);
      }
      console.error("cohort-dependencies:create failed", err);
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.delete("/cohort-dependencies/:id", (c) => {
    const id = c.req.param("id");
    const deleted = deleteCohortDependency(db, id);
    if (!deleted) {
      return c.json({ error: "not found" }, 404);
    }
    return c.body(null, 204);
  });
}

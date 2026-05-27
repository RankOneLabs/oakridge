import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { insertPlan, getPlan, listPlansBySpec, listPlansByStatus, updatePlanFields } from "../../db/plans";
import { getEpicBySpec } from "../../db/epics";
import { isFrozen } from "../../db/epic-freeze";
import type { Plan } from "../../types/task-tracker";

const CreatePlanSchema = z.object({
  spec_id: z.string().min(1),
  model: z.string().optional(),
});

const PatchPlanSchema = z.object({
  model: z.string().nullable().optional(),
});

interface PlansRouteDeps {
  db: Database;
}

export function mountPlansRoutes(app: Hono, deps: PlansRouteDeps): void {
  const { db } = deps;

  app.get("/plans", (c) => {
    const spec_id = c.req.query("spec_id");
    const status = c.req.query("status");

    if (status) {
      const validStatuses = ["pending_approval", "approved", "rejected", "superseded"] as const;
      type PlanStatus = (typeof validStatuses)[number];
      if (!validStatuses.includes(status as PlanStatus)) {
        return c.json({ error: "invalid status value" }, 400);
      }
      return c.json(listPlansByStatus(db, status as PlanStatus));
    }

    if (!spec_id) {
      return c.json({ error: "spec_id or status query param required" }, 400);
    }
    return c.json(listPlansBySpec(db, spec_id));
  });

  app.post("/plans", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = CreatePlanSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { spec_id, model } = result.data;

    const epicForCreate = getEpicBySpec(db, spec_id);
    if (epicForCreate && isFrozen(db, epicForCreate.id)) {
      return c.json({ error: "epic is archived" }, 409);
    }

    const id = crypto.randomUUID();

    try {
      const plan = db.transaction((): Plan => {
        const p = insertPlan(db, { id, spec_id, model: model ?? null, predecessor_plan_id: null });
        // specs.status dropped in migration 016; Epic.status + internal_status cover lifecycle.
        return p;
      })();
      return c.json(plan, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("FOREIGN KEY constraint failed")) {
        return c.json({ error: "spec not found" }, 404);
      }
      console.error("plans:create failed", err);
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.get("/plans/:id", (c) => {
    const id = c.req.param("id");
    const plan = getPlan(db, id);
    if (!plan) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(plan);
  });

  app.patch("/plans/:id", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    if (typeof body === "object" && body !== null && "status" in body) {
      return c.json(
        { error: "status not editable via PATCH /plans/:id; use PATCH /plans/:id/status" },
        400,
      );
    }

    const result = PatchPlanSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    if (Object.keys(result.data).length === 0) {
      return c.json({ error: "at least one mutable field is required" }, 400);
    }

    const id = c.req.param("id");

    const plan = getPlan(db, id);
    if (plan) {
      const epic = getEpicBySpec(db, plan.spec_id);
      if (epic && isFrozen(db, epic.id)) {
        return c.json({ error: "epic is archived" }, 409);
      }
    }

    const updated = updatePlanFields(db, id, result.data);
    if (!updated) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(updated);
  });
}

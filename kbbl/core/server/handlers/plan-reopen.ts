import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getPlan, insertPlan } from "../../db/plans";
import { unfreeze } from "../../review/freeze";
import type { Plan } from "../../types/task-tracker";

const PlanReopenSchema = z.object({
  model: z.string().optional(),
});

interface PlanReopenRouteDeps {
  db: Database;
}

export function mountPlanReopenRoutes(app: Hono, deps: PlanReopenRouteDeps): void {
  const { db } = deps;

  app.post("/plans/:id/reopen", async (c) => {
    let body: unknown;
    try {
      const text = await c.req.text();
      body = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = PlanReopenSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { model } = result.data;
    const old_id = c.req.param("id");

    let newPlan: Plan | null = null;

    try {
      const error = db.transaction((): string | null => {
        const oldPlan = getPlan(db, old_id);
        if (!oldPlan) return "not_found";
        if (oldPlan.status !== "approved" && oldPlan.status !== "rejected") return "not_reopenable";

        const new_id = crypto.randomUUID();
        newPlan = insertPlan(db, {
          id: new_id,
          spec_id: oldPlan.spec_id,
          model: model ?? oldPlan.model ?? null,
          predecessor_plan_id: old_id,
        });
        // Plans now default to 'draft' (the plan_writer agent submits them once
        // every cohort is posted). Reopen is an operator-driven path that does
        // not re-dispatch plan_writer, so the successor would otherwise be
        // stranded invisibly in draft. Put it straight into pending_approval to
        // preserve the prior reopen behaviour.
        db.prepare("UPDATE plans SET status = 'pending_approval' WHERE id = ?").run(new_id);
        newPlan = getPlan(db, new_id);

        unfreeze(db, "plan", old_id);
        db.prepare("UPDATE plans SET status = 'superseded' WHERE id = ?").run(old_id);
        // specs.status dropped in migration 016; Epic.status + internal_status cover lifecycle.

        return null;
      })();

      if (error === "not_found") return c.json({ error: "not found" }, 404);
      if (error === "not_reopenable") return c.json({ error: "plan must be in approved or rejected to reopen" }, 409);
    } catch (err) {
      console.error("plan-reopen:post failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    return c.json(newPlan, 201);
  });
}

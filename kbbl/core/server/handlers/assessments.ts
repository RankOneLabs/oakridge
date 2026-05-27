import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { insertAssessment, getAssessment, getAssessmentByPlan } from "../../db/assessments";
import { getEpicBySpec, advanceEpicByEvent } from "../../db/epics";
import { isFrozen } from "../../db/epic-freeze";
import { DeviationsCatalogEntrySchema } from "../../types/task-tracker";

const CreateAssessmentSchema = z.object({
  plan_id: z.string().min(1),
  summary: z.string().min(1),
  deviations_catalog: z.array(DeviationsCatalogEntrySchema),
  gap_analysis: z.string(),
  fix_plan: z.string(),
  model: z.string().optional(),
});

interface AssessmentsRouteDeps {
  db: Database;
}

export function mountAssessmentsRoutes(app: Hono, deps: AssessmentsRouteDeps): void {
  const { db } = deps;

  app.post("/assessments", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = CreateAssessmentSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { plan_id, summary, deviations_catalog, gap_analysis, fix_plan, model } = result.data;

    const planForAssessment = db
      .prepare<{ spec_id: string }, [string]>("SELECT spec_id FROM plans WHERE id = ?")
      .get(plan_id);
    if (planForAssessment) {
      const epic = getEpicBySpec(db, planForAssessment.spec_id);
      if (epic && isFrozen(db, epic.id)) {
        return c.json({ error: "epic is archived" }, 409);
      }
    }

    const id = crypto.randomUUID();

    try {
      const assessment = insertAssessment(db, {
        id,
        plan_id,
        summary,
        deviations_catalog,
        gap_analysis,
        fix_plan,
        model: model ?? null,
      });

      // Advance Epic stage: review → complete (epic_review_done)
      try {
        const planRow = db
          .prepare<{ spec_id: string }, [string]>("SELECT spec_id FROM plans WHERE id = ?")
          .get(plan_id);
        if (planRow) {
          const epic = getEpicBySpec(db, planRow.spec_id);
          if (epic) {
            advanceEpicByEvent(db, epic.id, "epic_review_done");
          }
        }
      } catch (err) {
        console.error(
          JSON.stringify({ kbbl: "assessments", warn: "advanceEpicByEvent(epic_review_done) failed", error: String(err), plan_id }),
        );
      }

      return c.json(assessment, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("FOREIGN KEY constraint failed")) {
        return c.json({ error: "plan not found" }, 404);
      }
      console.error("assessments:create failed", err);
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.get("/assessments/:id", (c) => {
    const id = c.req.param("id");
    const assessment = getAssessment(db, id);
    if (!assessment) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(assessment);
  });

  app.get("/plans/:id/assessment", (c) => {
    const plan_id = c.req.param("id");
    const assessment = getAssessmentByPlan(db, plan_id);
    if (!assessment) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(assessment);
  });
}

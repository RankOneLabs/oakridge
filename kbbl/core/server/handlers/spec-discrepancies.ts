import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  insertSpecDiscrepancy,
  getSpecDiscrepancy,
  listSpecDiscrepancies,
  updateSpecDiscrepancy,
} from "../../db/spec-discrepancies";
import { getEpicBySpec } from "../../db/epics";
import { isFrozen } from "../../db/epic-freeze";
import type { SpecDiscrepancy } from "../../types/task-tracker";

const CreateDiscrepancySchema = z.object({
  spec_id: z.string().min(1),
  spec_assumption: z.string().min(1),
  code_reality: z.string().min(1),
});

const PatchDiscrepancySchema = z.object({
  resolution: z.string().min(1),
  status: z.enum(["resolved", "waived"]),
});

interface SpecDiscrepanciesRouteDeps {
  db: Database;
}

export function mountSpecDiscrepanciesRoutes(app: Hono, deps: SpecDiscrepanciesRouteDeps): void {
  const { db } = deps;

  app.post("/spec-discrepancies", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = CreateDiscrepancySchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { spec_id, spec_assumption, code_reality } = result.data;

    const epic = getEpicBySpec(db, spec_id);
    if (epic && isFrozen(db, epic.id)) {
      return c.json({ error: "epic is archived" }, 409);
    }

    const id = crypto.randomUUID();

    try {
      const discrepancy = insertSpecDiscrepancy(db, {
        id,
        spec_id,
        spec_assumption,
        code_reality,
        resolution: null,
        status: "open",
      });
      return c.json(discrepancy, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("FOREIGN KEY constraint failed")) {
        return c.json({ error: "spec not found" }, 404);
      }
      console.error("spec-discrepancies:create failed", err);
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.get("/spec-discrepancies", (c) => {
    const spec_id = c.req.query("spec_id");
    if (!spec_id) {
      return c.json({ error: "spec_id query param required" }, 400);
    }
    return c.json(listSpecDiscrepancies(db, spec_id));
  });

  app.get("/spec-discrepancies/:id", (c) => {
    const id = c.req.param("id");
    const discrepancy = getSpecDiscrepancy(db, id);
    if (!discrepancy) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(discrepancy);
  });

  app.patch("/spec-discrepancies/:id", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = PatchDiscrepancySchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { resolution, status } = result.data;
    const id = c.req.param("id");

    const existing = getSpecDiscrepancy(db, id);
    if (existing) {
      const epic = getEpicBySpec(db, existing.spec_id);
      if (epic && isFrozen(db, epic.id)) {
        return c.json({ error: "epic is archived" }, 409);
      }
    }

    let updated: SpecDiscrepancy | null = null;

    let error: string | null;
    try {
      error = db.transaction((): string | null => {
        const existing = getSpecDiscrepancy(db, id);
        if (!existing) return "not_found";
        if (existing.status !== "open") return "not_open";

        updated = updateSpecDiscrepancy(db, id, { resolution, status });
        return null;
      })();
    } catch (err) {
      console.error("spec-discrepancies:patch failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    if (error === "not_found") return c.json({ error: "not found" }, 404);
    if (error === "not_open") return c.json({ error: "discrepancy is not open" }, 409);

    return c.json(updated);
  });

  app.delete("/spec-discrepancies/:id", (c) => {
    const id = c.req.param("id");
    const existing = getSpecDiscrepancy(db, id);
    if (!existing) {
      return c.json({ error: "not found" }, 404);
    }
    db.prepare("DELETE FROM spec_discrepancies WHERE id = ?").run(id);
    return new Response(null, { status: 204 });
  });
}

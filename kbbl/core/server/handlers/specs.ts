import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { insertSpec, getSpec, listSpecsByProject, updateSpecFields } from "../../db/specs";
import { taskTrackerEvents } from "../../db/events";

const CreateSpecSchema = z.object({
  project_id: z.string().min(1),
  title: z.string().min(1),
  notes: z.string().optional(),
});

const PatchSpecSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
});

interface SpecsRouteDeps {
  db: Database;
}

export function mountSpecsRoutes(app: Hono, deps: SpecsRouteDeps): void {
  const { db } = deps;

  app.get("/specs", (c) => {
    const project_id = c.req.query("project_id");
    if (!project_id) {
      return c.json({ error: "project_id query param required" }, 400);
    }
    return c.json(listSpecsByProject(db, project_id));
  });

  app.post("/specs", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = CreateSpecSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { project_id, title, notes } = result.data;
    const id = crypto.randomUUID();

    try {
      const spec = insertSpec(db, { id, project_id, title, notes: notes ?? null });
      taskTrackerEvents.emit("spec.created", { spec_id: spec.id });
      return c.json(spec, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("FOREIGN KEY constraint failed")) {
        return c.json({ error: "project not found" }, 404);
      }
      console.error("specs:create failed", err);
      return c.json({ error: "internal server error" }, 500);
    }
  });

  app.get("/specs/:id", (c) => {
    const id = c.req.param("id");
    const spec = getSpec(db, id);
    if (!spec) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(spec);
  });

  app.patch("/specs/:id", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    if (typeof body === "object" && body !== null && "status" in body) {
      return c.json(
        { error: "status not editable via PATCH /:id; use PATCH /:id/status" },
        400,
      );
    }

    const result = PatchSpecSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const id = c.req.param("id");
    const updated = updateSpecFields(db, id, result.data);
    if (!updated) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(updated);
  });
}

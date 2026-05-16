import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { resolve, relative, isAbsolute } from "node:path";
import { insertSpec, getSpec, listSpecsByProject, updateSpecFields } from "../../db/specs";
import { getProject } from "../../db/projects";
import { taskTrackerEvents } from "../../db/events";

const CreateSpecSchema = z
  .object({
    project_id: z.string().min(1),
    title: z.string().min(1),
    notes: z.string().optional(),
    notesPath: z.string().min(1).optional(),
  })
  .refine((v) => !(v.notes !== undefined && v.notesPath !== undefined), {
    message: "provide either notes or notesPath, not both",
    path: ["notesPath"],
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

    const { project_id, title, notes, notesPath } = result.data;
    const id = crypto.randomUUID();

    let resolvedNotes: string | null = notes ?? null;
    if (notesPath !== undefined) {
      // The kbbl server binds to 0.0.0.0 (tailnet-reachable, unauthenticated),
      // so any client that can reach the API could otherwise turn notesPath
      // into an arbitrary local-file read. Constrain reads to the project's
      // repo_path — operators load specs from files inside the repo anyway.
      const project = getProject(db, project_id);
      if (!project) {
        return c.json({ error: "project not found" }, 404);
      }
      const repoRoot = resolve(project.repo_path);
      const absNotesPath = isAbsolute(notesPath) ? resolve(notesPath) : resolve(repoRoot, notesPath);
      const rel = relative(repoRoot, absNotesPath);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return c.json({ error: "notesPath must resolve inside the project's repo_path" }, 400);
      }
      try {
        resolvedNotes = await Bun.file(absNotesPath).text();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT") || msg.includes("No such file")) {
          return c.json({ error: `notesPath not found: ${notesPath}` }, 400);
        }
        return c.json({ error: "unable to read notesPath" }, 400);
      }
    }

    try {
      const spec = insertSpec(db, { id, project_id, title, notes: resolvedNotes });
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
        { error: "status not editable via PATCH /specs/:id; use PATCH /specs/:id/status" },
        400,
      );
    }

    const result = PatchSpecSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    if (Object.keys(result.data).length === 0) {
      return c.json({ error: "at least one mutable field is required" }, 400);
    }

    const id = c.req.param("id");
    const updated = updateSpecFields(db, id, result.data);
    if (!updated) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(updated);
  });
}

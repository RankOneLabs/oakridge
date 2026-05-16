import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { realpathSync } from "node:fs";
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
      // kbbl routes are unauthenticated. When the server is bound to a
      // non-loopback host (e.g. --host=0.0.0.0 for tailnet access), any
      // reachable client could otherwise turn notesPath into an arbitrary
      // local-file read. Constrain reads to the project's repo_path — operators
      // load specs from files in the repo anyway — and resolve symlinks so an
      // in-repo symlink can't escape.
      const project = getProject(db, project_id);
      if (!project) {
        return c.json({ error: "project not found" }, 404);
      }
      let realRepoRoot: string;
      try {
        realRepoRoot = realpathSync(project.repo_path);
      } catch (err) {
        console.error("specs:create realpath(repo_path) failed", err);
        return c.json({ error: "internal server error" }, 500);
      }
      const absNotesPath = isAbsolute(notesPath) ? resolve(notesPath) : resolve(realRepoRoot, notesPath);
      let realNotesPath: string;
      try {
        realNotesPath = realpathSync(absNotesPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return c.json({ error: `notesPath not found: ${notesPath}` }, 400);
        }
        return c.json({ error: "unable to read notesPath" }, 400);
      }
      const rel = relative(realRepoRoot, realNotesPath);
      if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
        return c.json({ error: "notesPath must resolve inside the project's repo_path" }, 400);
      }
      try {
        resolvedNotes = await Bun.file(realNotesPath).text();
      } catch {
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

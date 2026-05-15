import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { insertProject, getProject, listProjects } from "../../db/projects";

const CreateProjectSchema = z.object({
  name: z.string().min(1),
  repo_path: z.string().refine((s) => s.startsWith("/"), {
    message: "repo_path must be an absolute path",
  }),
});

interface ProjectsRouteDeps {
  db: Database;
}

export function mountProjectsRoutes(app: Hono, deps: ProjectsRouteDeps): void {
  const { db } = deps;

  app.get("/projects", (c) => {
    return c.json(listProjects(db));
  });

  app.post("/projects", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = CreateProjectSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { name, repo_path } = result.data;
    const id = crypto.randomUUID();

    try {
      const project = insertProject(db, { id, name, repo_path });
      return c.json(project, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed")) {
        return c.json({ error: "repo_path already exists" }, 409);
      }
      return c.json({ error: msg }, 500);
    }
  });

  app.get("/projects/:id", (c) => {
    const id = c.req.param("id");
    const project = getProject(db, id);
    if (!project) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(project);
  });
}

import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { insertSpec, getSpec, listSpecsByProject, updateSpecFields } from "../../db/specs";
import { insertEpic, getEpicBySpec } from "../../db/epics";
import { isFrozen } from "../../db/epic-freeze";
import { getProject } from "../../db/projects";
import { taskTrackerEvents } from "../../db/events";
import type { RuntimeId, RuntimeRegistry } from "../../runtime";
import {
  AgentRuntimeChoiceSchema,
  EpicModelSelectionSchema,
} from "../../types/task-tracker";
import {
  defaultEpicModelSelections,
  isAllowedModelForRuntime,
  type RuntimeModelSelection,
} from "../../runtime";

const ModelSelectionInputSchema = EpicModelSelectionSchema;
const CreateSpecSchema = z
  .object({
    project_id: z.string().min(1),
    title: z.string().min(1),
    notes: z.string().optional(),
    notesPath: z.string().min(1).optional(),
    agent_runtime: AgentRuntimeChoiceSchema.optional(),
    planner_model_selection: ModelSelectionInputSchema.optional(),
    worker_model_selection: ModelSelectionInputSchema.optional(),
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
  registry?: RuntimeRegistry;
}

function isRuntimeRegistered(
  registry: RuntimeRegistry | undefined,
  runtimeId: RuntimeId,
): boolean {
  if (registry) return registry.runtimes.has(runtimeId);
  return runtimeId === "claude-code";
}

function validateModelSelection(
  registry: RuntimeRegistry | undefined,
  selection: RuntimeModelSelection,
  role: "planner" | "worker",
): string | null {
  if (!isRuntimeRegistered(registry, selection.runtime)) {
    return `runtime "${selection.runtime}" is not registered — registered: ${registry ? [...registry.runtimes.keys()].join(", ") : "claude-code"}`;
  }
  const runtime = registry?.runtimes.get(selection.runtime);
  if (!isAllowedModelForRuntime(runtime, selection.model)) {
    return `${role} model "${selection.model}" is not allowed for runtime "${selection.runtime}"`;
  }
  return null;
}

export function mountSpecsRoutes(app: Hono, deps: SpecsRouteDeps): void {
  const { db, registry } = deps;

  function registeredRuntimeList(): string {
    return registry ? [...registry.runtimes.keys()].join(", ") : "claude-code";
  }

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

    const {
      project_id,
      title,
      notes,
      notesPath,
      agent_runtime,
      planner_model_selection,
      worker_model_selection,
    } = result.data;

    if ((planner_model_selection === undefined) !== (worker_model_selection === undefined)) {
      return c.json(
        {
          error:
            "provide both planner_model_selection and worker_model_selection, or fall back to agent_runtime",
        },
        400,
      );
    }

    if (agent_runtime !== undefined && planner_model_selection !== undefined) {
      return c.json(
        { error: "provide either agent_runtime or the split model selections, not both" },
        400,
      );
    }

    let plannerSelection: RuntimeModelSelection;
    let workerSelection: RuntimeModelSelection;
    let legacyRuntime: RuntimeId;

    if (planner_model_selection && worker_model_selection) {
      if (planner_model_selection.runtime !== worker_model_selection.runtime) {
        return c.json(
          { error: "planner_model_selection.runtime must match worker_model_selection.runtime" },
          400,
        );
      }
      const plannerError = validateModelSelection(registry, planner_model_selection, "planner");
      if (plannerError) return c.json({ error: plannerError }, 400);
      const workerError = validateModelSelection(registry, worker_model_selection, "worker");
      if (workerError) return c.json({ error: workerError }, 400);
      plannerSelection = planner_model_selection;
      workerSelection = worker_model_selection;
      legacyRuntime = planner_model_selection.runtime;
    } else {
      const runtimeId: RuntimeId = agent_runtime ?? "claude-code";
      if (!isRuntimeRegistered(registry, runtimeId)) {
        return c.json(
          {
            error: `runtime "${runtimeId}" is not registered — registered: ${registeredRuntimeList()}`,
          },
          400,
        );
      }
      const defaults = defaultEpicModelSelections(runtimeId);
      plannerSelection = defaults.planner_model_selection;
      workerSelection = defaults.worker_model_selection;
      legacyRuntime = runtimeId;
    }

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
        realRepoRoot = await realpath(project.repo_path);
      } catch (err) {
        console.error("specs:create realpath(repo_path) failed", err);
        return c.json({ error: "internal server error" }, 500);
      }
      const absNotesPath = isAbsolute(notesPath) ? resolve(notesPath) : resolve(realRepoRoot, notesPath);
      let realNotesPath: string;
      try {
        realNotesPath = await realpath(absNotesPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          return c.json({ error: `notesPath not found: ${notesPath}` }, 400);
        }
        console.error("specs:create realpath(notesPath) failed", err);
        return c.json({ error: "internal server error" }, 500);
      }
      const rel = relative(realRepoRoot, realNotesPath);
      if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
        return c.json({ error: "notesPath must resolve inside the project's repo_path" }, 400);
      }
      try {
        resolvedNotes = await Bun.file(realNotesPath).text();
      } catch (err) {
        console.error("specs:create read(notesPath) failed", err);
        return c.json({ error: "unable to read notesPath" }, 500);
      }
    }

    try {
      const epic_id = crypto.randomUUID();
      const { spec, epic } = db.transaction(() => {
        const s = insertSpec(db, { id, project_id, title, notes: resolvedNotes });
        const e = insertEpic(db, {
          id: epic_id,
          spec_id: s.id,
          project_id,
          title,
          status: "pending",
          current_stage: "spec",
          agent_runtime: legacyRuntime,
          planner_model_selection: plannerSelection,
          worker_model_selection: workerSelection,
        });
        return { spec: s, epic: e };
      })();
      taskTrackerEvents.emit("spec.created", { spec_id: spec.id });
      return c.json({ ...spec, epic_id: epic.id }, 201);
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

    const result = PatchSpecSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    if (Object.keys(result.data).length === 0) {
      return c.json({ error: "at least one mutable field is required" }, 400);
    }

    const id = c.req.param("id");

    const epic = getEpicBySpec(db, id);
    if (epic && isFrozen(db, epic.id)) {
      return c.json({ error: "epic is archived" }, 409);
    }

    const updated = updateSpecFields(db, id, result.data);
    if (!updated) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(updated);
  });
}

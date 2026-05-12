import type { Context, Hono } from "hono";
import { SafirHttpError, type SafirClient } from "../../safir/client";
import type {
  ProposalDependency,
  ProposalStore,
  ProposalTask,
} from "../../proposals/store";

export interface PlanningProposalRouteDeps {
  proposalStore: ProposalStore;
  safirClient: SafirClient;
}

function isValidTask(t: unknown): t is ProposalTask {
  if (!t || typeof t !== "object") return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.index === "number" &&
    Number.isInteger(o.index) &&
    typeof o.title === "string" &&
    o.title.length > 0 &&
    typeof o.notes === "string" &&
    typeof o.priority === "number" &&
    Number.isInteger(o.priority)
  );
}

function isValidDep(d: unknown): d is ProposalDependency {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  return (
    typeof o.task_index === "number" &&
    Number.isInteger(o.task_index) &&
    typeof o.depends_on_index === "number" &&
    Number.isInteger(o.depends_on_index)
  );
}

function toposort(tasks: ProposalTask[], deps: ProposalDependency[]): number[] | null {
  const inDegree = new Map<number, number>();
  const adj = new Map<number, number[]>();
  for (const t of tasks) {
    inDegree.set(t.index, 0);
    adj.set(t.index, []);
  }
  for (const d of deps) {
    if (!inDegree.has(d.task_index) || !inDegree.has(d.depends_on_index)) return null;
    if (d.task_index === d.depends_on_index) return null;
    adj.get(d.depends_on_index)!.push(d.task_index);
    inDegree.set(d.task_index, (inDegree.get(d.task_index) ?? 0) + 1);
  }
  const queue: number[] = [];
  for (const [k, v] of inDegree.entries()) if (v === 0) queue.push(k);
  const order: number[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const next of adj.get(n) ?? []) {
      const nd = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nd);
      if (nd === 0) queue.push(next);
    }
  }
  return order.length === tasks.length ? order : null;
}

function respondToUpstreamError(
  c: Context<any, any, any>,
  err: unknown,
): Response {
  if (err instanceof SafirHttpError) {
    return c.json(
      { error: `safir HTTP ${err.status}`, status: err.status, body: err.body },
      err.status as Parameters<typeof c.json>[1],
    );
  }
  return c.json({ error: "safir unreachable" }, 502);
}

export function mountPlanningProposalRoutes(
  app: Hono,
  deps: PlanningProposalRouteDeps,
): void {
  const { proposalStore, safirClient } = deps;

  app.get("/planning-proposals", (c) => {
    const pending = proposalStore.list().filter((p) => p.status === "pending");
    return c.json(pending);
  });

  app.get("/planning-proposals/:id", (c) => {
    const id = c.req.param("id");
    const p = proposalStore.get(id);
    if (!p) return c.json({ error: "proposal not found" }, 404);
    return c.json(p);
  });

  app.post("/planning-proposals", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (
      typeof body?.parent_task_id !== "number" ||
      !Number.isInteger(body.parent_task_id) ||
      body.parent_task_id <= 0
    ) {
      return c.json({ error: "parent_task_id must be a positive integer" }, 400);
    }
    if (
      !Array.isArray(body.tasks) ||
      body.tasks.length === 0 ||
      !body.tasks.every(isValidTask)
    ) {
      return c.json(
        { error: "tasks must be a non-empty array of {index,title,notes,priority}" },
        400,
      );
    }
    if (!Array.isArray(body.dependencies) || !body.dependencies.every(isValidDep)) {
      return c.json(
        { error: "dependencies must be an array of {task_index, depends_on_index}" },
        400,
      );
    }
    if (typeof body.summary !== "string" || typeof body.model !== "string") {
      return c.json({ error: "summary and model must be strings" }, 400);
    }
    if (toposort(body.tasks, body.dependencies) === null) {
      return c.json({ error: "dependencies are invalid (cycle, self-dependency, or out-of-range index)" }, 400);
    }
    const existing = proposalStore.findPendingForParent(body.parent_task_id);
    if (existing) {
      return c.json(
        {
          error: "a pending proposal already exists for this parent",
          existing_proposal_id: existing.id,
        },
        409,
      );
    }
    const created = proposalStore.create({
      parent_task_id: body.parent_task_id,
      tasks: body.tasks as ProposalTask[],
      dependencies: body.dependencies as ProposalDependency[],
      summary: body.summary,
      model: body.model,
      created_at: typeof body.created_at === "string" ? body.created_at : undefined,
    });
    return c.json({ proposal_id: created.id, ...created }, 201);
  });

  app.post("/planning-proposals/:id/approve", async (c) => {
    const id = c.req.param("id");
    const p = proposalStore.get(id);
    if (!p) return c.json({ error: "proposal not found" }, 404);
    if (p.status !== "pending") {
      return c.json({ error: `proposal is ${p.status}; cannot approve` }, 409);
    }
    const order = toposort(p.tasks, p.dependencies);
    if (order === null) {
      proposalStore.markFailed(id, "stored proposal has a cycle");
      return c.json({ error: "stored proposal has a cycle" }, 500);
    }
    let parent;
    try {
      parent = await safirClient.getTask(p.parent_task_id);
    } catch (err) {
      proposalStore.markFailed(id, "failed to fetch parent task");
      return respondToUpstreamError(c, err);
    }
    const virtualToReal = new Map<number, number>();
    for (const idx of order) {
      const t = p.tasks.find((tk) => tk.index === idx)!;
      try {
        const created = await safirClient.createTask({
          project_id: parent.project_id,
          parent_id: p.parent_task_id,
          title: t.title,
          notes: t.notes,
          priority: t.priority,
        });
        virtualToReal.set(t.index, created.id);
      } catch (err) {
        const createdIds = [...virtualToReal.values()].join(", ");
        proposalStore.markFailed(id, `createTask failed for index ${t.index}; safir ids created so far: [${createdIds}]`);
        return respondToUpstreamError(c, err);
      }
    }
    for (const dep of p.dependencies) {
      const realTask = virtualToReal.get(dep.task_index);
      const realDep = virtualToReal.get(dep.depends_on_index);
      if (realTask == null || realDep == null) {
        proposalStore.markFailed(id, `internal: missing real id for dep ${dep.task_index}->${dep.depends_on_index}`);
        return c.json({ error: "internal error: proposal task mapping inconsistent" }, 500);
      }
      try {
        await safirClient.addDependency(realTask, realDep);
      } catch (err) {
        proposalStore.markFailed(id, `addDependency ${realTask}->${realDep} failed`);
        return respondToUpstreamError(c, err);
      }
    }
    proposalStore.delete(id);
    return c.json({ status: "approved", task_ids: [...virtualToReal.values()] });
  });

  app.post("/planning-proposals/:id/reject", (c) => {
    const id = c.req.param("id");
    const existed = proposalStore.delete(id);
    if (!existed) return c.json({ error: "proposal not found" }, 404);
    return c.json({ status: "rejected" });
  });
}

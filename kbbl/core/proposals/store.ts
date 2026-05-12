import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ProposalTask {
  index: number;
  title: string;
  notes: string;
  priority: number;
}

export interface ProposalDependency {
  task_index: number;
  depends_on_index: number;
}

export type ProposalStatus = "pending" | "approved" | "rejected" | "failed";

export interface PlanningProposal {
  id: string;
  parent_task_id: number;
  tasks: ProposalTask[];
  dependencies: ProposalDependency[];
  summary: string;
  model: string;
  status: ProposalStatus;
  failure_reason: string | null;
  created_at: string;
}

export interface CreateProposalInput {
  parent_task_id: number;
  tasks: ProposalTask[];
  dependencies: ProposalDependency[];
  summary: string;
  model: string;
  created_at?: string;
}

export interface ProposalStore {
  list(): PlanningProposal[];
  get(id: string): PlanningProposal | null;
  findPendingForParent(parentTaskId: number): PlanningProposal | null;
  create(input: CreateProposalInput): PlanningProposal;
  markFailed(id: string, reason: string): PlanningProposal | null;
  delete(id: string): boolean;
}

export interface CreateProposalStoreOpts {
  dataDir: string;
  uuid?: () => string;
  now?: () => Date;
}

export async function createProposalStore(
  opts: CreateProposalStoreOpts,
): Promise<ProposalStore> {
  const { dataDir } = opts;
  const uuid = opts.uuid ?? (() => randomUUID());
  const now = opts.now ?? (() => new Date());
  if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });

  const map = new Map<string, PlanningProposal>();
  const entries = await readdir(dataDir);
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dataDir, f), "utf8");
      const parsed = JSON.parse(raw) as PlanningProposal;
      if (parsed && typeof parsed.id === "string") map.set(parsed.id, parsed);
    } catch {
      // ignore unreadable / corrupt files
    }
  }

  async function persist(p: PlanningProposal): Promise<void> {
    await writeFile(join(dataDir, `${p.id}.json`), JSON.stringify(p, null, 2));
  }
  async function remove(id: string): Promise<void> {
    try {
      await unlink(join(dataDir, `${id}.json`));
    } catch {
      // ok if it never existed
    }
  }

  return {
    list(): PlanningProposal[] {
      return [...map.values()];
    },
    get(id: string): PlanningProposal | null {
      return map.get(id) ?? null;
    },
    findPendingForParent(parentTaskId: number): PlanningProposal | null {
      for (const p of map.values()) {
        if (p.parent_task_id === parentTaskId && p.status === "pending") return p;
      }
      return null;
    },
    create(input: CreateProposalInput): PlanningProposal {
      const proposal: PlanningProposal = {
        id: uuid(),
        parent_task_id: input.parent_task_id,
        tasks: input.tasks,
        dependencies: input.dependencies,
        summary: input.summary,
        model: input.model,
        status: "pending",
        failure_reason: null,
        created_at: input.created_at ?? now().toISOString(),
      };
      map.set(proposal.id, proposal);
      void persist(proposal);
      return proposal;
    },
    markFailed(id: string, reason: string): PlanningProposal | null {
      const p = map.get(id);
      if (!p) return null;
      const updated: PlanningProposal = {
        ...p,
        status: "failed",
        failure_reason: reason,
      };
      map.set(id, updated);
      void persist(updated);
      return updated;
    },
    delete(id: string): boolean {
      const existed = map.delete(id);
      if (existed) void remove(id);
      return existed;
    },
  };
}

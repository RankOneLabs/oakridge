import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import type { SafirClient } from "../../safir/client";
import { artifactEventBus } from "../../stream/artifact-event-bus";

const execFileP = promisify(execFile);

interface BuildRecord {
  briefId: string;
  runId: string;
  pid: number;
  stderrChunks: Buffer[];
}

const activeBuilds = new Map<string, BuildRecord>();

export interface BuildsRouteDeps {
  safirClient: SafirClient;
}

export function mountBuildsRoutes(app: Hono, deps: BuildsRouteDeps): void {
  const { safirClient } = deps;

  app.post("/safir-proxy/build-briefs/:id/build", async (c) => {
    const briefId = c.req.param("id").trim();
    if (!briefId) return c.json({ error: "briefId required" }, 400);

    // (a) assert brief is approved
    let brief: Record<string, unknown>;
    try {
      brief = await safirClient.getBuildBrief(briefId);
    } catch {
      return c.json({ error: "build brief not found" }, 404);
    }
    if (brief.status !== "approved") {
      return c.json({ error: "not_approved", message: "brief must be approved before triggering a build" }, 409);
    }

    // (b) assert no phase_index=1 already exists
    let runData: Record<string, unknown>;
    try {
      runData = await safirClient.getBuildBriefRun(briefId);
    } catch {
      return c.json({ error: "run not found for brief" }, 404);
    }
    const runId = runData.id as string;
    const phases = (runData.phases as Array<{ phase_index: number }>) ?? [];
    if (phases.some((p) => p.phase_index === 1)) {
      return c.json({ error: "already_started", message: "a build phase already exists for this run" }, 409);
    }

    // (c) resolve repo_path from the project
    // Chain: brief.run_id → run.task_id → task.project_id → project.repo_path
    let repoPath: string | null = null;
    try {
      const taskId = runData.task_id as number | undefined;
      if (taskId !== undefined) {
        const task = await safirClient.getTask(taskId);
        const projectId = task.project_id as string;
        const repoPathResult = await safirClient.getProjectRepoPath(projectId);
        repoPath = repoPathResult.repo_path ?? null;
      }
    } catch {
      // leave repoPath null; will 400 below
    }
    if (!repoPath) {
      return c.json(
        {
          error: "repo_path_unset",
          message: "configure projects.repo_path before triggering builds for this project",
        },
        400,
      );
    }

    // (d) create worktree
    const runShortId = runId.slice(0, 8);
    const worktreesDir = join(repoPath, ".kbbl-worktrees");
    const worktreePath = join(worktreesDir, runShortId);
    await mkdir(worktreesDir, { recursive: true });
    try {
      await execFileP("git", ["-C", repoPath, "worktree", "add", worktreePath, "main"]);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      return c.json({ error: "worktree_failed", detail: stderr }, 500);
    }

    // Log hint on first worktree creation (best-effort)
    console.log(`hint: add .kbbl-worktrees/ to ${repoPath}/.gitignore`);

    // (e) spawn safir-build subprocess
    const child = spawn("safir-build", ["--from-brief", briefId, "--workdir", worktreePath], {
      detached: false,
      stdio: ["ignore", "inherit", "pipe"],
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const pid = child.pid ?? 0;
    activeBuilds.set(briefId, { briefId, runId, pid, stderrChunks });

    // Emit build.started immediately
    artifactEventBus.publish("build_brief", briefId, "build.started", { brief_id: briefId, run_id: runId, pid }, new Date().toISOString());

    // (g) on subprocess exit, emit SSE
    child.on("exit", (code) => {
      activeBuilds.delete(briefId);
      const stderrBuf = Buffer.concat(stderrChunks);
      const stderrFull = stderrBuf.toString("utf8");
      const TAIL_BYTES = 4 * 1024;
      const stderrTail = stderrBuf.length > TAIL_BYTES
        ? stderrFull.slice(-TAIL_BYTES)
        : stderrFull;

      const ts = new Date().toISOString();
      if (code === 0) {
        artifactEventBus.publish("build_brief", briefId, "build.completed", {
          brief_id: briefId,
          run_id: runId,
        }, ts);
      } else {
        artifactEventBus.publish("build_brief", briefId, "build.failed", {
          brief_id: briefId,
          run_id: runId,
          code: code ?? -1,
          stderr_tail: stderrTail,
        }, ts);
      }
    });

    return c.json({ status: "build_started", subprocess_pid: pid, run_id: runId }, 202);
  });
}

import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { SafirHttpError, type SafirClient } from "../../safir/client";
import { artifactEventBus } from "../../stream/artifact-event-bus";

const execFileP = promisify(execFile);
const TAIL_BYTES = 4 * 1024;

interface BuildRecord {
  briefId: string;
  runId: string;
  pid: number;
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

    let body: Record<string, unknown> = {};
    try {
      const parsed = await c.req.json() as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const isRetry = body.retry === true;

    // Guard: block concurrent triggers at any await boundary that follows.
    // Placeholder is replaced with full record after spawn succeeds.
    if (activeBuilds.has(briefId)) {
      return c.json({ error: "already_running", message: "a build is already in progress for this brief" }, 409);
    }
    activeBuilds.set(briefId, { briefId, runId: "", pid: 0 });

    // (a) assert brief is approved
    let brief: Record<string, unknown>;
    try {
      brief = await safirClient.getBuildBrief(briefId);
    } catch (err) {
      activeBuilds.delete(briefId);
      if (err instanceof SafirHttpError) {
        return c.json(
          { error: `safir HTTP ${err.status}`, status: err.status, body: err.body },
          err.status as Parameters<typeof c.json>[1],
        );
      }
      return c.json({ error: "safir unreachable" }, 502);
    }
    if (brief.status !== "approved") {
      activeBuilds.delete(briefId);
      return c.json({ error: "not_approved", message: "brief must be approved before triggering a build" }, 409);
    }

    // (b) on retry: create a fresh run; on first build: assert no phase_index=1 already exists
    let runId: string;
    if (isRetry) {
      // Abandon the previous run so it doesn't stay in 'running' forever.
      try {
        const prevRun = await safirClient.getBuildBriefRun(briefId);
        if (prevRun.id) await safirClient.abandonRun(prevRun.id as string);
      } catch (err) {
        // Best-effort: SafirHttpError is expected and silent (e.g. run already terminal, or 404
        // if the brief has no run yet — both allow the retry to proceed via createRunFromBuildBrief).
        // Unexpected failures (network, 5xx) are logged so they're visible in operator logs.
        if (!(err instanceof SafirHttpError)) {
          console.error(`kbbl: abandonRun for brief ${briefId} failed:`, err);
        }
      }

      let newRun: { id: string };
      try {
        newRun = await safirClient.createRunFromBuildBrief(briefId, {
          executor: "builder:retry",
          created_by: "kbbl",
        });
      } catch (err) {
        activeBuilds.delete(briefId);
        if (err instanceof SafirHttpError) {
          return c.json(
            { error: `safir HTTP ${err.status}`, status: err.status, body: err.body },
            err.status as Parameters<typeof c.json>[1],
          );
        }
        return c.json({ error: "safir unreachable" }, 502);
      }
      runId = newRun.id;
    } else {
      let runData: Record<string, unknown>;
      try {
        runData = await safirClient.getBuildBriefRun(briefId);
      } catch (err) {
        activeBuilds.delete(briefId);
        if (err instanceof SafirHttpError) {
          return c.json(
            { error: `safir HTTP ${err.status}`, status: err.status, body: err.body },
            err.status as Parameters<typeof c.json>[1],
          );
        }
        return c.json({ error: "safir unreachable" }, 502);
      }
      runId = runData.id as string;
      const phases = (runData.phases as Array<{ phase_index: number }>) ?? [];
      if (phases.some((p) => p.phase_index === 1)) {
        activeBuilds.delete(briefId);
        return c.json({ error: "already_started", message: "a build phase already exists for this run" }, 409);
      }
    }

    // (c) resolve repo_path from the project via brief.task_id
    let repoPath: string | null = null;
    try {
      const taskId = typeof brief.task_id === "number" ? brief.task_id : null;
      if (taskId !== null) {
        const task = await safirClient.getTask(taskId);
        const projectId = task.project_id as string;
        const repoPathResult = await safirClient.getProjectRepoPath(projectId);
        repoPath = repoPathResult.repo_path ?? null;
      }
    } catch {
      // leave repoPath null; will 400 below
    }
    if (!repoPath) {
      activeBuilds.delete(briefId);
      return c.json(
        {
          error: "repo_path_unset",
          message: "configure projects.repo_path before triggering builds for this project",
        },
        400,
      );
    }

    // (d) create worktree — use --detach so we don't try to check out the same
    // branch twice when the repo already has main checked out.
    const runShortId = runId.slice(0, 8);
    const worktreesDir = join(repoPath, ".kbbl-worktrees");
    const worktreePath = join(worktreesDir, runShortId);
    await mkdir(worktreesDir, { recursive: true });
    try {
      await execFileP("git", ["-C", repoPath, "worktree", "add", "--detach", worktreePath, "main"]);
    } catch (err) {
      activeBuilds.delete(briefId);
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

    // Accumulate a rolling TAIL_BYTES window of stderr to bound memory usage.
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      while (stderrBytes > TAIL_BYTES && stderrChunks.length > 1) {
        const dropped = stderrChunks.shift()!;
        stderrBytes -= dropped.length;
      }
    });

    const pid = child.pid ?? 0;
    activeBuilds.set(briefId, { briefId, runId, pid });

    // Emit build.started immediately
    artifactEventBus.publish("build_brief", briefId, "build.started", { brief_id: briefId, run_id: runId, pid }, new Date().toISOString());

    // Handle spawn failures (e.g. safir-build not in PATH)
    child.on("error", (spawnErr) => {
      activeBuilds.delete(briefId);
      const stderrTail = Buffer.concat(stderrChunks).subarray(-TAIL_BYTES).toString("utf8");
      artifactEventBus.publish("build_brief", briefId, "build.failed", {
        brief_id: briefId,
        run_id: runId,
        code: -1,
        stderr_tail: stderrTail,
        error: spawnErr.message,
      }, new Date().toISOString());
    });

    // (g) on subprocess exit, emit SSE
    child.on("exit", (code) => {
      activeBuilds.delete(briefId);
      const stderrTail = Buffer.concat(stderrChunks).subarray(-TAIL_BYTES).toString("utf8");

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

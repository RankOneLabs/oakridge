/**
 * Webhook consumer for thread.agent_response_started events.
 *
 * Loads the thread context from safir, spawns the Python review responder
 * subprocess (python -m builder.review_responder_runner), passes the full
 * ReviewResponderContext as stdin JSON, parses the JSONL result, and reports
 * the outcome back to safir via POST /threads/:id/agent-response.
 *
 * Integrated via SafirWebhookRouteDeps.reviewResponder — safir-webhook.ts
 * calls this function for thread.agent_response_started events.
 */

import type { AgentResponseBody, SafirClient } from "../../safir/client";

export interface ReviewResponderSubprocessResult {
  status: "completed" | "failed";
  reply_message_id?: string | null;
  error?: string | null;
  conflicts: unknown[];
}

export interface SpawnOpts {
  cmd: string[];
  stdinPayload: string;
}

export type SpawnAgentFn = (opts: SpawnOpts) => Promise<ReviewResponderSubprocessResult>;

export interface ReviewResponderDispatchDeps {
  safirClient: SafirClient;
  safirBaseUrl: string;
  pythonBin?: string;
  /** Test seam: inject a stub instead of spawning a real subprocess. */
  spawnAgent?: SpawnAgentFn;
}

async function defaultSpawnAgent(
  opts: SpawnOpts,
): Promise<ReviewResponderSubprocessResult> {
  const TIMEOUT_MS = 5 * 60_000;
  const proc = Bun.spawn({
    cmd: opts.cmd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
  });

  proc.stdin.write(new TextEncoder().encode(opts.stdinPayload));
  proc.stdin.end();

  // Drain stdout and stderr concurrently to avoid pipe-buffer deadlock.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // Always attempt to parse stdout first: the runner emits structured JSON
  // to stdout even on non-zero exit (e.g. context-parse failures, timeout kill).
  const lastLine = stdout.trim().split("\n").pop() ?? "";
  if (lastLine) {
    try {
      return JSON.parse(lastLine) as ReviewResponderSubprocessResult;
    } catch {
      // fall through to stderr-based error below
    }
  }

  if (exitCode !== 0) {
    return {
      status: "failed",
      error: `subprocess exited ${exitCode}: ${stderr.slice(0, 500)}`,
      conflicts: [],
    };
  }

  return { status: "failed", error: "subprocess produced no output", conflicts: [] };
}

async function loadDependencyBriefsNotes(
  client: SafirClient,
  targetType: string,
  targetId: string,
): Promise<string[] | null> {
  if (targetType !== "build_brief") return null;
  try {
    const brief = await client.getBuildBrief(targetId);
    const taskId = typeof brief.task_id === "number" ? brief.task_id : null;
    if (taskId === null) return [];
    const deps = await client.listTaskDependencies(taskId);
    if (deps.length === 0) return [];
    const allHandoffs = await Promise.all(
      deps.map((dep) => client.listHandoffsForTask(dep.depends_on)),
    );
    const notes: string[] = [];
    for (const handoffs of allHandoffs) {
      const approved = (handoffs as Array<Record<string, unknown>>)
        .filter((h) => h.status === "approved")
        .sort((a, b) =>
          String(b.produced_at ?? "").localeCompare(String(a.produced_at ?? "")),
        );
      const top = approved[0];
      if (top && typeof top.raw_markdown === "string") {
        notes.push(top.raw_markdown);
      }
    }
    return notes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ kbbl: "review_responder_deps_load_error", error: msg }),
    );
    return null;
  }
}

export async function dispatchReviewResponder(
  data: Record<string, unknown>,
  deps: ReviewResponderDispatchDeps,
): Promise<void> {
  const threadId = typeof data.thread_id === "string" ? data.thread_id : null;
  const targetType = typeof data.target_type === "string" ? data.target_type : null;
  const targetId = typeof data.target_id === "string" ? data.target_id : null;

  if (!threadId || !targetType || !targetId) {
    console.error(
      JSON.stringify({
        kbbl: "review_responder_dispatch_error",
        reason: "missing_required_fields",
        data,
      }),
    );
    return;
  }

  let agentResponseBody: AgentResponseBody;

  try {
    // Load thread, atom map, other open threads, and dep context in parallel.
    const [thread, atomMap, allOpenThreads, dependencyBriefsNotes] = await Promise.all([
      deps.safirClient.getThread(threadId),
      deps.safirClient.getAtomMap(targetType, targetId),
      deps.safirClient.listOpenThreads(targetType, targetId),
      loadDependencyBriefsNotes(deps.safirClient, targetType, targetId),
    ]);

    // Load parent context.
    let parentTaskNotes = "";
    if (targetType === "plan") {
      try {
        const plan = await deps.safirClient.getPlan(targetId);
        const parentTaskId = plan.parent_task_id as number | null | undefined;
        if (parentTaskId != null) {
          const task = await deps.safirClient.getTask(parentTaskId);
          parentTaskNotes = (task as Record<string, unknown>).notes as string ?? "";
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          JSON.stringify({ kbbl: "review_responder_parent_load_error", error: msg }),
        );
      }
    }

    // Filter other open threads to exclude the pinged thread itself.
    const otherOpenThreads = allOpenThreads.filter(
      (t) => (t as Record<string, unknown>).id !== threadId,
    );

    const ctxPayload = JSON.stringify({
      target_type: targetType,
      target_id: targetId,
      thread_id: threadId,
      thread,
      atom_map: atomMap,
      other_open_threads: otherOpenThreads,
      parent_task_notes: parentTaskNotes,
      dependency_briefs_notes: dependencyBriefsNotes,
    });

    const pythonBin = deps.pythonBin ?? "python3";
    const cmd = [
      pythonBin,
      "-m",
      "builder.review_responder_runner",
      "--target-type",
      targetType,
      "--target-id",
      targetId,
      "--thread-id",
      threadId,
      "--safir-base-url",
      deps.safirBaseUrl,
    ];

    const spawn = deps.spawnAgent ?? defaultSpawnAgent;
    const result = await spawn({ cmd, stdinPayload: ctxPayload });

    agentResponseBody = {
      status: result.status,
      ...(result.reply_message_id != null
        ? { reply_message_id: result.reply_message_id }
        : {}),
      ...(result.error != null ? { error: result.error } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ kbbl: "review_responder_dispatch_error", error: msg }),
    );
    agentResponseBody = { status: "failed", error: msg };
  }

  try {
    await deps.safirClient.postAgentResponse(threadId, agentResponseBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        kbbl: "review_responder_agent_response_post_error",
        thread_id: threadId,
        error: msg,
      }),
    );
  }
}

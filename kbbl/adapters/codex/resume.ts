// Codex resume: uses thread/fork to create a child thread off the parent's threadId.
// The parent's threadId is stored in the archived JSONL as runtime_session_observed.thread_id
// (or runtime_session_observed.runtime_sid for the generic v2 field).

import { join } from "node:path";
import type { ResumeRef } from "../../core/runtime";
import { readJsonlOrEmpty } from "../../core/session/session";

export interface CodexResumeRef {
  threadId: string;
  workdir: string;
  parentWorktreePath: string | null;
  model: string | null;
}

/**
 * Read the session JSONL and extract the Codex thread id for resuming.
 * The thread id is stored in runtime_session_observed events with runtime_id: "codex".
 * Falls back to runtime_sid field for generic storage.
 */
export async function resolveCodexResumeRef(
  sessionsDir: string,
  oakridgeSid: string,
): Promise<ResumeRef> {
  const jsonlPath = join(sessionsDir, `${oakridgeSid}.jsonl`);
  let contents: string;
  try {
    contents = await readJsonlOrEmpty(jsonlPath);
  } catch (err) {
    console.error(
      `kbbl codex: failed to read parent jsonl ${jsonlPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { kind: "unknown" };
  }

  if (!contents) return { kind: "unknown" };

  let threadId: string | null = null;
  let workdir: string | null = null;
  let parentWorktreePath: string | null = null;
  let model: string | null = null;

  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let evt: { type: string; payload: unknown };
    try {
      evt = JSON.parse(line) as { type: string; payload: unknown };
    } catch {
      continue;
    }

    const payload =
      typeof evt.payload === "object" && evt.payload !== null
        ? (evt.payload as Record<string, unknown>)
        : {};

    if (evt.type === "runtime_session_observed") {
      // Generic field: runtime_sid — only accept from Codex-tagged events
      if (payload.runtime_id === "codex" && typeof payload.runtime_sid === "string") {
        threadId = payload.runtime_sid;
      }
      // Legacy field: thread_id (early probe sessions had no runtime_id tag)
      if (typeof payload.thread_id === "string") {
        threadId = payload.thread_id;
      }
    }

    if (evt.type === "session_started") {
      if (typeof payload.workdir === "string") workdir = payload.workdir;
      if (typeof payload.worktreePath === "string")
        parentWorktreePath = payload.worktreePath;
      if (typeof payload.model === "string") model = payload.model;
    }

    if (threadId && workdir) break;
  }

  if (!threadId) return { kind: "no_runtime_sid" };
  if (!workdir) return { kind: "no_workdir" };

  return {
    kind: "ok",
    runtimeSid: threadId,
    workdir,
    parentWorktreePath,
    model,
  };
}

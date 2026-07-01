import type { Hono } from "hono";
import { isAbsolute, join, resolve } from "node:path";
import { stat } from "node:fs/promises";

import {
  MAX_ARTIFACT_ID_LENGTH,
  type ArtifactId,
  readJsonlOrEmpty,
  type EnvelopeEvent,
} from "../../session/session";
import {
  NonGitWorkdirError,
  RemoveFailedError,
  SessionManager,
  type CreateSessionOpts,
} from "../../session/session-manager";
import type { AgentRuntime, RuntimeId, RuntimeRegistry } from "../../runtime";
import { isValidSid } from "./per-sid";

// Fallback allowlist used when no RuntimeRegistry is wired (legacy / test mode).
// Mirrors the CC adapter's ALLOWED_MODELS; kept here so core has no adapter import.
const LEGACY_ALLOWED_MODELS: readonly string[] = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "opus",
  "sonnet",
  "haiku",
];

interface ParentSessionPayload {
  readonly [key: string]: unknown;
  readonly cc_session_id?: unknown;
  readonly workdir?: unknown;
  readonly worktreePath?: unknown;
  readonly model?: unknown;
  readonly runtimeId?: unknown;
}

function parentSessionPayload(payload: unknown): ParentSessionPayload {
  return (
    typeof payload === "object" && payload !== null ? payload : {}
  ) as ParentSessionPayload;
}

/**
 * Validates a workdir string for POST /sessions and optional server startup
 * --workdir checks. Returns null if OK or a human-readable error string for
 * the 400 response. We require absolute paths so the spawn cwd is
 * unambiguous regardless of how the operator launched the server, and
 * verify existence + directory-ness so the failure surfaces as a clear 400
 * instead of a downstream Bun.spawn error. Operator input is trusted (this
 * is a localhost/tailnet tool), so no sandbox/allowlist beyond that.
 */
export async function validateWorkdir(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return "workdir must be an absolute path";
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return "workdir is not a directory";
  } catch (err) {
    // Distinguish "doesn't exist" (operator typo) from "exists but unreadable"
    // (permission error). The path-prefix logging hint matters when an
    // operator's stat fails on EACCES — they'd otherwise be told "doesn't
    // exist" while it's right there.
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") return "workdir does not exist";
    const msg = err instanceof Error ? err.message : String(err);
    return `workdir not accessible: ${msg}`;
  }
  return null;
}

/**
 * Look up a resume parent's ccSid + workdir. Checks the live map first
 * (fast path) then falls back to parsing the on-disk JSONL. Returns a
 * tagged result so the POST handler can map each failure case to a
 * distinct status code.
 *
 * NOTE: scans for `cc_session_id_observed` and `session_started` event
 * types — both are CC-specific event names. When the CC adapter moves out
 * in PR 3, this lookup becomes a runtime-mediated `runtime.resolveResumeRef()`
 * call so the core stops parsing CC-specific JSONL.
 */
type ResumeParentResult =
  | { kind: "unknown" }
  | { kind: "no_runtime_sid" }
  | { kind: "no_workdir" }
  | {
      kind: "ok";
      parentRuntimeSid: string;
      workdir: string;
      /**
       * Set if the parent had a per-session worktree (Phase 1+); null for
       * pre-Phase-1 archived parents. When set, lets the POST handler
       * distinguish "parent's worktree was discarded" from a generic
       * "workdir doesn't exist" so the caller sees an actionable error.
       */
      parentWorktreePath: string | null;
      parentModel: string | null;
      parentRuntimeId: RuntimeId;
    };

async function resolveResumeParent(
  manager: SessionManager,
  sessionsDir: string,
  sid: string,
): Promise<ResumeParentResult> {
  const live = manager.get(sid);
  if (live) {
    const ccSid = live.currentCcSid;
    if (!ccSid) return { kind: "no_runtime_sid" };
    return {
      kind: "ok",
      parentRuntimeSid: ccSid,
      workdir: live.workdir,
      parentWorktreePath: live.worktreePath,
      parentModel: live.model,
      parentRuntimeId: live.runtimeId,
    };
  }
  const jsonlPath = join(sessionsDir, `${sid}.jsonl`);
  let contents: string;
  try {
    contents = await readJsonlOrEmpty(jsonlPath);
  } catch (err) {
    // Same EACCES / I/O error surface as loadArchivedSnapshot — treat
    // as unknown rather than 500 the resume call, but log the cause so
    // an operator seeing an unexpected 404 on resume has a breadcrumb
    // (the alternative is indistinguishable from a genuinely unknown
    // sid).
    console.error(
      `kbbl: failed to read parent jsonl ${jsonlPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { kind: "unknown" };
  }
  if (!contents) return { kind: "unknown" };
  let parentCcSid: string | null = null;
  let parentWorkdir: string | null = null;
  let parentWorktreePath: string | null = null;
  let parentModel: string | null = null;
  let parentRuntimeId: RuntimeId = "claude-code";
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let evt: EnvelopeEvent;
    try {
      evt = JSON.parse(line) as EnvelopeEvent;
    } catch {
      continue;
    }
    const payload = parentSessionPayload(evt.payload);
    if (
      evt.type === "cc_session_id_observed" &&
      typeof payload.cc_session_id === "string"
    ) {
      parentCcSid = payload.cc_session_id;
    }
    if (evt.type === "session_started") {
      if (typeof payload.workdir === "string") {
        parentWorkdir = payload.workdir;
      }
      if (typeof payload.worktreePath === "string") {
        parentWorktreePath = payload.worktreePath;
      }
      if (typeof payload.model === "string" && LEGACY_ALLOWED_MODELS.includes(payload.model)) {
        parentModel = payload.model;
      }
      if (payload.runtimeId === "claude-code" || payload.runtimeId === "codex") {
        parentRuntimeId = payload.runtimeId;
      }
    }
    if (parentCcSid && parentWorkdir) break;
  }
  if (!parentCcSid) return { kind: "no_runtime_sid" };
  // Fail rather than guess if the parent transcript is missing the workdir
  // (e.g. truncated very early). Falling back to the current --workdir would
  // silently launch the resumed session in a different repo if the operator
  // restarted the server with a different default — quietly applying tool
  // edits against the wrong tree.
  if (!parentWorkdir) return { kind: "no_workdir" };
  return {
    kind: "ok",
    parentRuntimeSid: parentCcSid,
    workdir: parentWorkdir,
    parentWorktreePath,
    parentModel,
    parentRuntimeId,
  };
}

function isRuntimeId(value: unknown): value is RuntimeId {
  return value === "claude-code" || value === "codex";
}

async function resolveParentRuntimeId(
  manager: SessionManager,
  sessionsDir: string,
  sid: string,
): Promise<RuntimeId | null> {
  const live = manager.get(sid);
  if (live) return live.runtimeId;

  const jsonlPath = join(sessionsDir, `${sid}.jsonl`);
  let contents: string;
  try {
    contents = await readJsonlOrEmpty(jsonlPath);
  } catch (err) {
    console.error(
      `kbbl: failed to read parent jsonl ${jsonlPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  if (!contents) return null;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let evt: EnvelopeEvent;
    try {
      evt = JSON.parse(line) as EnvelopeEvent;
    } catch {
      continue;
    }
    if (evt.type !== "session_started") continue;
    const payload = parentSessionPayload(evt.payload);
    return isRuntimeId(payload.runtimeId) ? payload.runtimeId : "claude-code";
  }
  return null;
}

export interface SessionsRouteDeps {
  manager: SessionManager;
  /** Optional server default workdir (from --workdir CLI arg). */
  defaultWorkdir: string | null;
  /** Path to the on-disk sessions directory for archived JSONL lookups. */
  sessionsDir: string;
  /**
   * Optional runtime registry for model validation. When present, delegates
   * to the default runtime's isAllowedModel() method. When absent, falls back
   * to LEGACY_ALLOWED_MODELS (the CC adapter's static allowlist).
   */
  registry?: RuntimeRegistry;
}

/**
 * Registers `GET /sessions`, `POST /sessions`, and `DELETE /sessions/:sid`
 * on the given Hono app.
 */
export function mountSessionsRoutes(app: Hono, deps: SessionsRouteDeps): void {
  const { manager, defaultWorkdir, sessionsDir, registry } = deps;

  function runtimeForId(runtimeId: RuntimeId): AgentRuntime | null {
    return registry?.runtimes.get(runtimeId) ?? null;
  }

  function registeredRuntimeList(): string {
    return registry ? [...registry.runtimes.keys()].join(", ") : "claude-code";
  }

  function isAllowedModelForRuntime(
    runtime: AgentRuntime | null,
    value: string,
  ): boolean {
    if (!registry) return LEGACY_ALLOWED_MODELS.includes(value);
    if (!runtime) return false;
    if (runtime.isAllowedModel) return runtime.isAllowedModel(value);
    return runtime.descriptor.models.some((m) => m.value === value);
  }

  app.get("/sessions", async (c) => {
    const inMemory = manager.listSnapshots();
    const include = c.req.query("include");
    if (include !== "archived") return c.json({ sessions: inMemory });
    // Scan data/sessions/*.jsonl for sessions from prior runs. Ordered newest
    // first by lastActivityTs so the PWA can render without a second sort.
    const archived = await manager.listArchivedSnapshots();
    const merged = [...inMemory, ...archived].sort((a, b) => {
      if (a.lastActivityTs === b.lastActivityTs) return 0;
      return a.lastActivityTs < b.lastActivityTs ? 1 : -1;
    });
    return c.json({ sessions: merged });
  });

  app.post("/sessions", async (c) => {
    // Optional body: { resume_from?: string, workdir?: string, name?: string
    // (≤80 chars), artifact_id?, model? }. Fresh sessions require either an
    // explicit workdir or an operator-configured server default.
    // resume_from is an oakridgeSid whose parent CC session should be
    // inherited as context via --resume <parentCcSid> --fork-session, and
    // ignores any workdir override (the parent's workdir is authoritative).
    let resumeFrom: string | null = null;
    let bodyWorkdir: string | null = null;
    let bodyName: string | null = null;
    let bodyArtifactId: ArtifactId | null = null;
    let bodyModel: string | null = null;
    let bodyRuntime: RuntimeId | null = null;
    // Read raw text first so we can distinguish "no body" (treat as no
    // options, preserves the old POST /sessions behavior) from "bad body"
    // (400). Using c.req.json() with an inner .catch() would silently
    // turn malformed JSON into "no options" — a bad body would create
    // a fresh session instead of erroring.
    try {
      const bodyText = await c.req.text();
      if (bodyText !== "") {
        const raw = JSON.parse(bodyText) as unknown;
        // Reject arrays / strings / numbers explicitly: property access on
        // them silently yields undefined, so without this check a body like
        // `[]` or `"foo"` would slip through as "no options" and spawn a
        // fresh session under --workdir, masking client bugs.
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          return c.json({ error: "json body must be an object" }, 400);
        }
        const parsed = raw as {
          resume_from?: unknown;
          workdir?: unknown;
          name?: unknown;
          artifact_id?: unknown;
          model?: unknown;
          runtime?: unknown;
        };
        if (parsed.runtime !== undefined) {
          if (typeof parsed.runtime !== "string") {
            return c.json({ error: "runtime must be a string" }, 400);
          }
          if (!isRuntimeId(parsed.runtime)) {
            return c.json(
              {
                error: `unknown runtime: ${parsed.runtime} — registered: ${registeredRuntimeList()}`,
              },
              400,
            );
          }
          if (registry && !registry.runtimes.has(parsed.runtime)) {
            return c.json(
              {
                error: `runtime "${parsed.runtime}" is not registered — registered: ${registeredRuntimeList()}`,
              },
              400,
            );
          }
          if (!registry && parsed.runtime !== "claude-code") {
            return c.json(
              { error: `runtime "${parsed.runtime}" is not registered — registered: claude-code` },
              400,
            );
          }
          bodyRuntime = parsed.runtime;
        }
        if (parsed.resume_from !== undefined) {
          if (typeof parsed.resume_from !== "string") {
            return c.json({ error: "resume_from must be a string" }, 400);
          }
          resumeFrom = parsed.resume_from;
        }
        if (parsed.workdir !== undefined) {
          if (typeof parsed.workdir !== "string") {
            return c.json({ error: "workdir must be a string" }, 400);
          }
          bodyWorkdir = parsed.workdir;
        }
        if (parsed.name !== undefined) {
          if (typeof parsed.name !== "string") {
            return c.json({ error: "name must be a string" }, 400);
          }
          // Validate after trimming so leading/trailing whitespace can't
          // push an otherwise-valid name past the cap. All-whitespace
          // trims to empty, which manager.create()'s slug fallback
          // handles the same as an omitted name, so we just store the
          // trimmed value (possibly empty) and let create() decide.
          const trimmedName = parsed.name.trim();
          if (trimmedName.length > 80) {
            return c.json(
              { error: "name must be ≤ 80 chars after trimming" },
              400,
            );
          }
          bodyName = trimmedName;
        }
        if (parsed.artifact_id !== undefined) {
          if (typeof parsed.artifact_id !== "string") {
            return c.json({ error: "artifact_id must be a string" }, 400);
          }
          const trimmedArtifactId = parsed.artifact_id.trim();
          // Empty string would silently degrade to "no tag" once it
          // hits Session.artifactId, masking client bugs that forgot
          // to populate the id. Reject explicitly so the workspace
          // layer can't accidentally tag a whole ensemble as
          // "anonymous artifact".
          if (trimmedArtifactId === "") {
            return c.json(
              { error: "artifact_id must be non-empty when provided" },
              400,
            );
          }
          // Cap length: shared MAX_ARTIFACT_ID_LENGTH is enforced at
          // every entry point (handler, Session constructor, archived
          // snapshot reconstruction) so the invariant holds wherever
          // an id might come from.
          if (trimmedArtifactId.length > MAX_ARTIFACT_ID_LENGTH) {
            return c.json(
              {
                error: `artifact_id must be ≤ ${MAX_ARTIFACT_ID_LENGTH} chars after trimming`,
              },
              400,
            );
          }
          // Store the trimmed value so leading/trailing whitespace can't
          // make listByArtifact() lookups brittle.
          bodyArtifactId = trimmedArtifactId as ArtifactId;
        }
        if (parsed.model !== undefined) {
          if (typeof parsed.model !== "string") {
            return c.json({ error: "model must be a string" }, 400);
          }
          const trimmedModel = parsed.model.trim();
          if (trimmedModel === "") {
            return c.json(
              { error: "model must be non-empty when provided" },
              400,
            );
          }
          bodyModel = trimmedModel;
        }
      }
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    let spawnOpts: CreateSessionOpts;
    if (resumeFrom === null) {
      // Validate the raw input first so the absolute-path guard fires for
      // client-supplied relative paths. resolve() would otherwise turn
      // "./foo" into the server's cwd + "./foo" and silently accept it as
      // an absolute path, reintroducing the cwd-dependent behavior the API
      // is meant to forbid.
      const requestedWorkdir = bodyWorkdir ?? defaultWorkdir;
      if (requestedWorkdir === null) {
        return c.json({ error: "workdir is required" }, 400);
      }
      const err = await validateWorkdir(requestedWorkdir);
      if (err) return c.json({ error: err }, 400);
      // Now canonicalize so /repo, /repo/, and /repo/..//repo all collapse
      // to one canonical workdir before persistence — matches the startup
      // --workdir handling so the same path doesn't show up as two distinct
      // workdirs across the UI.
      const target = resolve(requestedWorkdir);
      const selectedRuntimeId = bodyRuntime ?? registry?.defaultId ?? "claude-code";
      const selectedRuntime = runtimeForId(selectedRuntimeId);
      if (bodyModel !== null && !isAllowedModelForRuntime(selectedRuntime, bodyModel)) {
        return c.json(
          {
            error: registry
              ? `unknown model for ${selectedRuntimeId}: ${bodyModel}`
              : `unknown model: ${bodyModel}`,
          },
          400,
        );
      }
      spawnOpts = {
        workdir: target,
        name: bodyName ?? undefined,
        artifactId: bodyArtifactId ?? undefined,
        runtime: bodyRuntime ?? undefined,
        model: bodyModel ?? undefined,
      };
    } else {
      if (!isValidSid(resumeFrom)) {
        return c.json({ error: "invalid resume_from" }, 400);
      }

      // Prefer runtime.resolveResumeRef when a registry is available, so
      // CC-specific JSONL parsing stays in the CC adapter. Fall back to the
      // core-owned resolver for legacy/no-registry callers.
      let parentInfo: ResumeParentResult;
      if (registry) {
        const parentRuntimeId =
          (await resolveParentRuntimeId(manager, sessionsDir, resumeFrom)) ??
          registry.defaultId;
        if (bodyRuntime !== null && bodyRuntime !== parentRuntimeId) {
          return c.json(
            {
              error: `resume_from parent runtime is ${parentRuntimeId}; cross-runtime resume to ${bodyRuntime} is not supported`,
            },
            400,
          );
        }
        const resumeRuntime = registry.runtimes.get(parentRuntimeId);
        const liveSession = manager.get(resumeFrom);
        if (!resumeRuntime) {
          return c.json(
            {
              error: `resume_from parent runtime "${parentRuntimeId}" is not registered`,
            },
            400,
          );
        } else {
          const ref = await resumeRuntime.resolveResumeRef(sessionsDir, resumeFrom);
          if (ref.kind === "unknown") {
            // JSONL unknown — check live session directly.
            if (liveSession) {
              const runtimeSid = liveSession.snapshot().runtimeSid;
              if (!runtimeSid) {
                parentInfo = { kind: "no_runtime_sid" };
              } else {
                parentInfo = {
                  kind: "ok",
                  parentRuntimeSid: runtimeSid,
                  workdir: liveSession.workdir,
                  parentWorktreePath: liveSession.worktreePath,
                  parentModel: liveSession.model,
                  parentRuntimeId: liveSession.runtimeId,
                };
              }
            } else {
              parentInfo = { kind: "unknown" };
            }
          } else if (ref.kind === "no_runtime_sid") {
            parentInfo = { kind: "no_runtime_sid" };
          } else if (ref.kind === "no_workdir") {
            parentInfo = { kind: "no_workdir" };
          } else if (ref.kind === "ok") {
            parentInfo = {
              kind: "ok",
              parentRuntimeSid: ref.runtimeSid,
              workdir: ref.workdir,
              parentWorktreePath: ref.parentWorktreePath,
              parentModel: ref.model,
              parentRuntimeId,
            };
          } else {
            parentInfo = { kind: "unknown" };
          }
        }
      } else {
        parentInfo = await resolveResumeParent(manager, sessionsDir, resumeFrom);
      }
      if (parentInfo.kind === "unknown") {
        return c.json({ error: "unknown resume_from session" }, 404);
      }
      if (parentInfo.kind === "no_runtime_sid") {
        // Parent session never exposed a runtime session id — there's nothing
        // to resume against. Distinct 400 so the PWA can show a specific
        // error rather than "spawn failed".
        return c.json(
          {
            error:
              "resume_from parent never observed a runtime session id — can't resume",
          },
          400,
        );
      }
      if (parentInfo.kind === "no_workdir") {
        // Parent transcript exists but is missing session_started.workdir
        // (truncated very early). Fail explicitly rather than guess at the
        // current --workdir, which could be a different repo entirely after
        // a server restart.
        return c.json(
          {
            error:
              "resume_from parent transcript is missing the workdir — can't resume safely",
          },
          400,
        );
      }
      const selectedRuntimeId = bodyRuntime ?? parentInfo.parentRuntimeId;
      if (selectedRuntimeId !== parentInfo.parentRuntimeId) {
        return c.json(
          {
            error: `resume_from parent runtime is ${parentInfo.parentRuntimeId}; cross-runtime resume to ${selectedRuntimeId} is not supported`,
          },
          400,
        );
      }
      const selectedRuntime = runtimeForId(selectedRuntimeId);
      const selectedModel = bodyModel ?? parentInfo.parentModel;
      if (selectedModel !== null && !isAllowedModelForRuntime(selectedRuntime, selectedModel)) {
        return c.json(
          {
            error: registry
              ? `unknown model for ${selectedRuntimeId}: ${selectedModel}`
              : `unknown model: ${selectedModel}`,
          },
          400,
        );
      }
      // Validate the inherited workdir before spawn — archived metadata
      // can outlive the directory it points at (e.g. operator deleted the
      // worktree). Without this check, Bun.spawn fails downstream and the
      // caller sees an opaque 500. Re-resolve so a parent stored as
      // /repo/.//worktree still validates against /repo/worktree.
      const parentWorkdir = resolve(parentInfo.workdir);
      const parentErr = await validateWorkdir(parentWorkdir);
      if (parentErr) {
        // Distinguish "the parent's worktree was discarded" from a generic
        // missing-workdir. Discard is a documented Phase 2 operator action,
        // so the message should make the cause clear instead of reading
        // like a kbbl bug. Detected via: parent had a worktreePath at
        // session_started time AND the dir is gone now.
        if (
          parentInfo.parentWorktreePath !== null &&
          parentErr === "workdir does not exist"
        ) {
          return c.json(
            {
              error: "resume_from parent's worktree was discarded",
            },
            400,
          );
        }
        return c.json(
          { error: `resume_from parent workdir invalid: ${parentErr}` },
          400,
        );
      }
      spawnOpts = {
        // Spawn under the parent's workdir, not the server default. If the
        // operator restarted the server with a different --workdir, the
        // resumed subprocess still needs parent's cwd to match what the
        // transcript assumes.
        workdir: parentWorkdir,
        name: bodyName ?? undefined,
        parentCcSid: parentInfo.parentRuntimeSid,
        parentOakridgeSid: resumeFrom,
        artifactId: bodyArtifactId ?? undefined,
        runtime: selectedRuntimeId,
        model: selectedModel ?? undefined,
      };
    }

    try {
      const session = await manager.create(spawnOpts);
      return c.json(session.snapshot());
    } catch (err) {
      if (err instanceof NonGitWorkdirError) {
        return c.json({ error: err.message }, 400);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `spawn failed: ${msg}` }, 500);
    }
  });

  app.get("/artifacts/:artifactId/sessions", (c) => {
    const rawArtifactId = c.req.param("artifactId");
    // Empty/missing artifactId would land here only via bizarre routing
    // anomalies (Hono normally 404s before this), but explicit guard
    // keeps the failure clear for any future router substitution.
    if (!rawArtifactId) return c.json({ error: "missing artifactId" }, 400);
    // Mirror POST /sessions validation so behavior is consistent across
    // the artifact-tag entry points: trim, reject empty-after-trim,
    // enforce the shared length cap.
    const trimmed = rawArtifactId.trim();
    if (!trimmed) {
      return c.json({ error: "artifactId must be non-empty" }, 400);
    }
    if (trimmed.length > MAX_ARTIFACT_ID_LENGTH) {
      return c.json(
        {
          error: `artifactId must be ≤ ${MAX_ARTIFACT_ID_LENGTH} chars after trimming`,
        },
        400,
      );
    }
    const sessions = manager
      .listByArtifact(trimmed as ArtifactId)
      .map((s) => s.snapshot());
    return c.json({ sessions });
  });

  app.delete("/sessions/:sid", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    // ?purge=true is a hard delete (drop map entry + delete JSONL). Without
    // it, the existing abort-only semantic is preserved so the PWA's Stop
    // button keeps the ended transcript visible. Treat any non-falsy value
    // as truthy ("1", "true", "yes") to match common URL convention.
    // Lowercase once so falsy variants like ?purge=False / FALSE / NO are
    // recognized — without this, mixed-case spellings would unexpectedly
    // trigger a hard delete.
    const purgeParam = c.req.query("purge")?.toLowerCase();
    const purge =
      purgeParam !== undefined &&
      purgeParam !== "" &&
      purgeParam !== "0" &&
      purgeParam !== "false" &&
      purgeParam !== "no" &&
      purgeParam !== "off";
    if (purge) {
      manager.get(sid)?.markEndReason("user_closed");
      let removed: boolean;
      try {
        removed = await manager.remove(sid);
      } catch (err) {
        if (err instanceof RemoveFailedError) {
          // unlink failed for a non-ENOENT reason (EACCES/EBUSY/EIO/etc).
          // Surface as 500 so the client doesn't see a misleading
          // "removed:true" — the transcript may still be on disk and would
          // reappear after restart. The full message (with JSONL path) is
          // logged server-side; the response body intentionally omits the
          // path since the server runs on 0.0.0.0 (tailnet) and we don't
          // want to disclose filesystem layout to anyone who can hit it.
          console.error(`kbbl: ${err.message}`);
          return c.json({ error: "purge failed" }, 500);
        }
        throw err;
      }
      if (!removed) return c.json({ error: "unknown session" }, 404);
      return c.json({ ok: true, removed: true });
    }
    const session = manager.get(sid);
    if (!session) return c.json({ error: "unknown session" }, 404);
    session.markEndReason("user_closed");
    const code = await session.abort();
    return c.json({ ok: true, code });
  });
}

import type { Hono } from "hono";
import { isAbsolute, join, resolve } from "node:path";
import { stat } from "node:fs/promises";

import {
  MAX_ARTIFACT_ID_LENGTH,
  type ArtifactId,
  type EnvelopeEvent,
  readJsonlOrEmpty,
} from "../../session/session";
import {
  type CreateSessionOpts,
  NonGitWorkdirError,
  RemoveFailedError,
  SessionManager,
} from "../../session/session-manager";
import type { AgentRuntime, RuntimeId, RuntimeRegistry } from "../../runtime";
import { isValidSid } from "./per-sid";
import type { DelegatedCallback, OutputSlot } from "../callbacks";

// Fallback allowlist used when no RuntimeRegistry is wired (legacy / test mode).
// Mirrors the CC adapter's ALLOWED_MODELS; kept here so core has no adapter import.
const LEGACY_ALLOWED_MODELS: readonly string[] = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "opus",
  "sonnet",
  "haiku",
];

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
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") return "workdir does not exist";
    const msg = err instanceof Error ? err.message : String(err);
    return `workdir not accessible: ${msg}`;
  }
  return null;
}

function isRuntimeId(value: unknown): value is RuntimeId {
  return value === "claude-code" || value === "codex";
}

/**
 * Determine the runtime a resume parent ran under, so the right runtime's
 * resolveResumeRef() parses its transcript. Live sessions report it directly;
 * archived parents are read from their `session_started` event. `runtimeId` is
 * a core concept (not runtime-specific), so reading it here keeps the
 * runtime-specific JSONL parsing inside the adapter's resolveResumeRef().
 */
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
    const payload =
      typeof evt.payload === "object" && evt.payload !== null
        ? (evt.payload as Record<string, unknown>)
        : {};
    return isRuntimeId(payload.runtimeId) ? payload.runtimeId : "claude-code";
  }
  return null;
}

export interface SessionsRouteDeps {
  manager: SessionManager;
  /** Optional server default workdir (from --workdir CLI arg). */
  defaultWorkdir: string | null;
  /** On-disk sessions directory, for resolving resume parents' transcripts. */
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

  /**
   * POST /sessions — C.1 delegated-execution contract.
   *
   * Body (all fields required unless noted):
   *   backend          "claude-code" | "codex"
   *   prompt           string — rendered prompt, seeded as the first turn
   *   workdir          string — absolute path; falls back to server default
   *   model?           string — optional model override
   *   pre_authorized_tools  string[] — tools to allowlist before first turn
   *   yolo             boolean — enable yolo mode (auto-approve all tools)
   *   output_slots     Array<{name, artifact_type}> — declared output slots
   *   callback         { base_url, stage_instance_id, emit_path, status_path }
   */
  app.post("/sessions", async (c) => {
    let bodyBackend: RuntimeId | null = null;
    let bodyPrompt: string | null = null;
    let bodyWorkdir: string | null = null;
    let bodyModel: string | null = null;
    let bodyPreAuthorizedTools: string[] | null = null;
    let bodyYolo: boolean | null = null;
    let bodyOutputSlots: OutputSlot[] | null = null;
    let bodyCallback: DelegatedCallback | null = null;

    try {
      const bodyText = await c.req.text();
      if (bodyText === "") {
        return c.json({ error: "json body is required" }, 400);
      }
      const raw = JSON.parse(bodyText) as unknown;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return c.json({ error: "json body must be an object" }, 400);
      }
      const parsed = raw as Record<string, unknown>;

      // backend (required)
      if (parsed.backend === undefined) {
        return c.json({ error: "backend is required" }, 400);
      }
      if (typeof parsed.backend !== "string") {
        return c.json({ error: "backend must be a string" }, 400);
      }
      if (!isRuntimeId(parsed.backend)) {
        return c.json(
          {
            error: `unknown backend: ${parsed.backend} — valid: claude-code, codex`,
          },
          400,
        );
      }
      bodyBackend = parsed.backend;

      // prompt (required, non-empty)
      if (parsed.prompt === undefined) {
        return c.json({ error: "prompt is required" }, 400);
      }
      if (typeof parsed.prompt !== "string") {
        return c.json({ error: "prompt must be a string" }, 400);
      }
      if (parsed.prompt.trim() === "") {
        return c.json({ error: "prompt must be non-empty" }, 400);
      }
      bodyPrompt = parsed.prompt.trim();

      // workdir (optional — falls back to server default)
      if (parsed.workdir !== undefined) {
        if (typeof parsed.workdir !== "string") {
          return c.json({ error: "workdir must be a string" }, 400);
        }
        bodyWorkdir = parsed.workdir;
      }

      // model (optional)
      if (parsed.model !== undefined) {
        if (typeof parsed.model !== "string") {
          return c.json({ error: "model must be a string" }, 400);
        }
        const trimmedModel = parsed.model.trim();
        if (trimmedModel === "") {
          return c.json({ error: "model must be non-empty when provided" }, 400);
        }
        bodyModel = trimmedModel;
      }

      // pre_authorized_tools (required, array of strings)
      if (parsed.pre_authorized_tools === undefined) {
        return c.json({ error: "pre_authorized_tools is required" }, 400);
      }
      if (!Array.isArray(parsed.pre_authorized_tools)) {
        return c.json({ error: "pre_authorized_tools must be an array" }, 400);
      }
      const parsedTools: string[] = [];
      for (const t of parsed.pre_authorized_tools) {
        if (typeof t !== "string") {
          return c.json(
            { error: "pre_authorized_tools must be an array of strings" },
            400,
          );
        }
        const trimmed = t.trim();
        if (trimmed === "") {
          return c.json(
            { error: "pre_authorized_tools entries must be non-empty strings" },
            400,
          );
        }
        parsedTools.push(trimmed);
      }
      bodyPreAuthorizedTools = parsedTools;

      // yolo (required, boolean)
      if (parsed.yolo === undefined) {
        return c.json({ error: "yolo is required" }, 400);
      }
      if (typeof parsed.yolo !== "boolean") {
        return c.json({ error: "yolo must be a boolean" }, 400);
      }
      bodyYolo = parsed.yolo;

      // output_slots (required, array of objects)
      if (parsed.output_slots === undefined) {
        return c.json({ error: "output_slots is required" }, 400);
      }
      if (!Array.isArray(parsed.output_slots)) {
        return c.json({ error: "output_slots must be an array" }, 400);
      }
      const parsedSlots: OutputSlot[] = [];
      for (const slot of parsed.output_slots) {
        if (typeof slot !== "object" || slot === null) {
          return c.json({ error: "output_slots elements must be objects" }, 400);
        }
        const s = slot as Record<string, unknown>;
        if (typeof s.name !== "string" || s.name.trim() === "") {
          return c.json(
            { error: "output_slots[].name must be a non-empty string" },
            400,
          );
        }
        if (
          typeof s.artifact_type !== "string" ||
          s.artifact_type.trim() === ""
        ) {
          return c.json(
            { error: "output_slots[].artifact_type must be a non-empty string" },
            400,
          );
        }
        parsedSlots.push({
          name: s.name.trim(),
          artifact_type: s.artifact_type.trim(),
        });
      }
      bodyOutputSlots = parsedSlots;

      // callback (required object)
      if (parsed.callback === undefined) {
        return c.json({ error: "callback is required" }, 400);
      }
      if (typeof parsed.callback !== "object" || parsed.callback === null) {
        return c.json({ error: "callback must be an object" }, 400);
      }
      const cb = parsed.callback as Record<string, unknown>;
      if (typeof cb.base_url !== "string" || cb.base_url.trim() === "") {
        return c.json(
          { error: "callback.base_url must be a non-empty string" },
          400,
        );
      }
      if (
        typeof cb.stage_instance_id !== "string" ||
        cb.stage_instance_id.trim() === ""
      ) {
        return c.json(
          { error: "callback.stage_instance_id must be a non-empty string" },
          400,
        );
      }
      if (typeof cb.emit_path !== "string" || cb.emit_path.trim() === "") {
        return c.json(
          { error: "callback.emit_path must be a non-empty string" },
          400,
        );
      }
      if (typeof cb.status_path !== "string" || cb.status_path.trim() === "") {
        return c.json(
          { error: "callback.status_path must be a non-empty string" },
          400,
        );
      }
      const cbBaseUrl = cb.base_url.trim();
      const cbStageInstanceId = cb.stage_instance_id.trim();
      const cbEmitPath = cb.emit_path.trim();
      const cbStatusPath = cb.status_path.trim();

      // Validate callback shapes up front. callbacks.ts concatenates these
      // verbatim ({base_url}{emit_path}, /stages/{stage_instance_id}/approvals),
      // and a failed callback there only logs — so a malformed URL/path would
      // otherwise strand a live delegated stage with no report path back to
      // oakridge. Reject the request now instead.
      let parsedBaseUrl: URL;
      try {
        parsedBaseUrl = new URL(cbBaseUrl);
      } catch {
        return c.json({ error: "callback.base_url must be a valid URL" }, 400);
      }
      if (
        parsedBaseUrl.protocol !== "http:" &&
        parsedBaseUrl.protocol !== "https:"
      ) {
        return c.json({ error: "callback.base_url must be an http(s) URL" }, 400);
      }
      if (!cbEmitPath.startsWith("/") || /\s/.test(cbEmitPath)) {
        return c.json(
          {
            error:
              "callback.emit_path must be an absolute path (leading '/', no whitespace)",
          },
          400,
        );
      }
      if (!cbStatusPath.startsWith("/") || /\s/.test(cbStatusPath)) {
        return c.json(
          {
            error:
              "callback.status_path must be an absolute path (leading '/', no whitespace)",
          },
          400,
        );
      }
      if (!/^[A-Za-z0-9._-]+$/.test(cbStageInstanceId)) {
        return c.json(
          {
            error:
              "callback.stage_instance_id must be path-safe ([A-Za-z0-9._-])",
          },
          400,
        );
      }
      bodyCallback = {
        base_url: cbBaseUrl,
        stage_instance_id: cbStageInstanceId,
        emit_path: cbEmitPath,
        status_path: cbStatusPath,
      };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    // Workdir resolution: body value > server default.
    const requestedWorkdir = bodyWorkdir ?? defaultWorkdir;
    if (requestedWorkdir === null) {
      return c.json({ error: "workdir is required" }, 400);
    }
    const wdErr = await validateWorkdir(requestedWorkdir);
    if (wdErr) return c.json({ error: wdErr }, 400);
    const target = resolve(requestedWorkdir);

    // Backend registration check. Registry is required — without it we can't
    // validate or route the backend, so reject rather than silently spawn the
    // wrong runtime.
    if (!registry) {
      return c.json({ error: "server has no runtime registry" }, 500);
    }
    if (!registry.runtimes.has(bodyBackend!)) {
      return c.json(
        {
          error: `backend "${bodyBackend}" is not registered — registered: ${registeredRuntimeList()}`,
        },
        400,
      );
    }

    // Model validation.
    const selectedRuntime = runtimeForId(bodyBackend!);
    if (bodyModel !== null && !isAllowedModelForRuntime(selectedRuntime, bodyModel)) {
      return c.json(
        {
          error: registry
            ? `unknown model for ${bodyBackend}: ${bodyModel}`
            : `unknown model: ${bodyModel}`,
        },
        400,
      );
    }

    // Idempotency (C.1 recovery): if oakridge re-POSTs for a stage_instance_id
    // whose session is still live — e.g. it crashed after kbbl created the
    // session but before persisting the returned sid — return the existing
    // session instead of spawning a duplicate. Two claude processes resuming the
    // same transcript would interleave writes and corrupt the JSONL.
    const existingDelegated = manager.getDelegatedByStageInstance(
      bodyCallback!.stage_instance_id,
    );
    if (existingDelegated) {
      return c.json(existingDelegated.snapshot());
    }

    try {
      const session = await manager.create({
        workdir: target,
        runtime: bodyBackend!,
        model: bodyModel,
        prompt: bodyPrompt!,
        preAuthorizedTools: bodyPreAuthorizedTools!,
        yoloMode: bodyYolo!,
        outputSlots: bodyOutputSlots!,
        delegatedCallback: bodyCallback!,
      });
      return c.json(session.snapshot());
    } catch (err) {
      if (err instanceof NonGitWorkdirError) {
        return c.json({ error: err.message }, 400);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `spawn failed: ${msg}` }, 500);
    }
  });

  /**
   * POST /sessions/operator — operator-initiated session create / resume.
   *
   * The human entry point (PWA "+ New session" and per-row Resume), distinct
   * from POST /sessions (the delegated C.1 contract driven by oakridge-core).
   * Body: { resume_from?, workdir?, name?, artifact_id?, model?, runtime? }.
   * Fresh sessions need an explicit workdir (or the server default). With
   * resume_from (a parent oakridgeSid), the parent's CC session is inherited
   * via --resume <ccSid> --fork-session and the parent's workdir is
   * authoritative — any workdir override is ignored.
   */
  app.post("/sessions/operator", async (c) => {
    // Registry is required: this path routes by runtime and resolves resume
    // refs through the runtime, so without it we can't validate or spawn.
    if (!registry) {
      return c.json({ error: "server has no runtime registry" }, 500);
    }

    let resumeFrom: string | null = null;
    let bodyWorkdir: string | null = null;
    let bodyName: string | null = null;
    let bodyArtifactId: ArtifactId | null = null;
    let bodyModel: string | null = null;
    let bodyRuntime: RuntimeId | null = null;
    // Read raw text first so "no body" (treat as fresh under the server
    // default) is distinct from "bad body" (400) — c.req.json() with an inner
    // catch would silently turn malformed JSON into a fresh-session spawn.
    try {
      const bodyText = await c.req.text();
      if (bodyText !== "") {
        const raw = JSON.parse(bodyText) as unknown;
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
          if (!registry.runtimes.has(parsed.runtime)) {
            return c.json(
              {
                error: `runtime "${parsed.runtime}" is not registered — registered: ${registeredRuntimeList()}`,
              },
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
          const trimmedName = parsed.name.trim();
          if (trimmedName.length > 80) {
            return c.json({ error: "name must be ≤ 80 chars after trimming" }, 400);
          }
          bodyName = trimmedName;
        }
        if (parsed.artifact_id !== undefined) {
          if (typeof parsed.artifact_id !== "string") {
            return c.json({ error: "artifact_id must be a string" }, 400);
          }
          const trimmedArtifactId = parsed.artifact_id.trim();
          if (trimmedArtifactId === "") {
            return c.json(
              { error: "artifact_id must be non-empty when provided" },
              400,
            );
          }
          if (trimmedArtifactId.length > MAX_ARTIFACT_ID_LENGTH) {
            return c.json(
              {
                error: `artifact_id must be ≤ ${MAX_ARTIFACT_ID_LENGTH} chars after trimming`,
              },
              400,
            );
          }
          bodyArtifactId = trimmedArtifactId as ArtifactId;
        }
        if (parsed.model !== undefined) {
          if (typeof parsed.model !== "string") {
            return c.json({ error: "model must be a string" }, 400);
          }
          const trimmedModel = parsed.model.trim();
          if (trimmedModel === "") {
            return c.json({ error: "model must be non-empty when provided" }, 400);
          }
          bodyModel = trimmedModel;
        }
      }
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    let spawnOpts: CreateSessionOpts;
    if (resumeFrom === null) {
      // Fresh session: require an absolute workdir (body > server default).
      const requestedWorkdir = bodyWorkdir ?? defaultWorkdir;
      if (requestedWorkdir === null) {
        return c.json({ error: "workdir is required" }, 400);
      }
      const err = await validateWorkdir(requestedWorkdir);
      if (err) return c.json({ error: err }, 400);
      const target = resolve(requestedWorkdir);
      const selectedRuntimeId = bodyRuntime ?? registry.defaultId;
      const selectedRuntime = runtimeForId(selectedRuntimeId);
      if (bodyModel !== null && !isAllowedModelForRuntime(selectedRuntime, bodyModel)) {
        return c.json(
          { error: `unknown model for ${selectedRuntimeId}: ${bodyModel}` },
          400,
        );
      }
      spawnOpts = {
        workdir: target,
        name: bodyName ?? undefined,
        artifactId: bodyArtifactId ?? undefined,
        runtime: selectedRuntimeId,
        model: bodyModel ?? undefined,
      };
    } else {
      // Resume: inherit the parent's CC session + workdir.
      if (!isValidSid(resumeFrom)) {
        return c.json({ error: "invalid resume_from" }, 400);
      }
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
      if (!resumeRuntime) {
        return c.json(
          { error: `resume_from parent runtime "${parentRuntimeId}" is not registered` },
          400,
        );
      }

      let parentRuntimeSid: string;
      let parentWorkdir: string;
      let parentWorktreePath: string | null;
      let parentModel: string | null;
      const ref = await resumeRuntime.resolveResumeRef(sessionsDir, resumeFrom);
      if (ref.kind === "ok") {
        parentRuntimeSid = ref.runtimeSid;
        parentWorkdir = ref.workdir;
        parentWorktreePath = ref.parentWorktreePath;
        parentModel = ref.model;
      } else if (ref.kind === "no_runtime_sid") {
        return c.json(
          { error: "resume_from parent never observed a runtime session id — can't resume" },
          400,
        );
      } else if (ref.kind === "no_workdir") {
        return c.json(
          { error: "resume_from parent transcript is missing the workdir — can't resume safely" },
          400,
        );
      } else {
        // Transcript unknown — fall back to a live session if one exists.
        const live = manager.get(resumeFrom);
        if (!live) {
          return c.json({ error: "unknown resume_from session" }, 404);
        }
        const snap = live.snapshot();
        if (!snap.runtimeSid) {
          return c.json(
            { error: "resume_from parent never observed a runtime session id — can't resume" },
            400,
          );
        }
        parentRuntimeSid = snap.runtimeSid;
        parentWorkdir = live.workdir;
        parentWorktreePath = live.worktreePath;
        parentModel = live.model;
      }

      const selectedModel = bodyModel ?? parentModel;
      const selectedRuntime = runtimeForId(parentRuntimeId);
      if (
        selectedModel !== null &&
        !isAllowedModelForRuntime(selectedRuntime, selectedModel)
      ) {
        return c.json(
          { error: `unknown model for ${parentRuntimeId}: ${selectedModel}` },
          400,
        );
      }
      // Validate the inherited workdir before spawn — archived metadata can
      // outlive the directory it points at (e.g. operator discarded the
      // worktree). Re-resolve so /repo/.//worktree validates as /repo/worktree.
      const resolvedParentWorkdir = resolve(parentWorkdir);
      const parentErr = await validateWorkdir(resolvedParentWorkdir);
      if (parentErr) {
        if (parentWorktreePath !== null && parentErr === "workdir does not exist") {
          return c.json({ error: "resume_from parent's worktree was discarded" }, 400);
        }
        return c.json(
          { error: `resume_from parent workdir invalid: ${parentErr}` },
          400,
        );
      }
      spawnOpts = {
        workdir: resolvedParentWorkdir,
        name: bodyName ?? undefined,
        parentCcSid: parentRuntimeSid,
        parentOakridgeSid: resumeFrom,
        artifactId: bodyArtifactId ?? undefined,
        runtime: parentRuntimeId,
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
    if (!rawArtifactId) return c.json({ error: "missing artifactId" }, 400);
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

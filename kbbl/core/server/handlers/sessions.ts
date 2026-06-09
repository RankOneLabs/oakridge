import type { Hono } from "hono";
import { isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";

import {
  MAX_ARTIFACT_ID_LENGTH,
  type ArtifactId,
} from "../../session/session";
import {
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
      for (const t of parsed.pre_authorized_tools) {
        if (typeof t !== "string") {
          return c.json(
            { error: "pre_authorized_tools must be an array of strings" },
            400,
          );
        }
      }
      bodyPreAuthorizedTools = parsed.pre_authorized_tools as string[];

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
      bodyCallback = {
        base_url: cb.base_url.trim(),
        stage_instance_id: cb.stage_instance_id.trim(),
        emit_path: cb.emit_path.trim(),
        status_path: cb.status_path.trim(),
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

    // Backend registration check (only when a registry is wired).
    if (registry && !registry.runtimes.has(bodyBackend!)) {
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

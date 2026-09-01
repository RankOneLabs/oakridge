import type { Hono } from "hono";
import { isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";

import { MAX_ARTIFACT_ID_LENGTH, type ArtifactId } from "../../session/types";
import type { SessionManager } from "../../session/session-manager";
import type { AcpSessionService } from "../../acp/session-service";
import type { AcpError, AcpSessionStartSpec } from "../../acp/types";
import {
  toLegacySnapshot,
  toLegacyStatus,
  toTerminalBody,
} from "../../acp/legacy-wire";
import {
  archivedLegacyToPwaSnapshot,
  toPwaSessionSnapshot,
} from "../../acp/pwa-wire";
import { listPwaSessions } from "./acp-inbox";
import { isValidSid } from "./acp-per-sid";
import { findSessionHold, isTruthyFlag, selectCloseAuthority, selectCloseRefusal } from "../session-hold";

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

/** Bounds for the `wait_ms` query parameter on the terminal-observation route. */
export const TERMINAL_WAIT_MS_DEFAULT = 25_000;
export const TERMINAL_WAIT_MS_MAX = 60_000;

export const selectTerminalWaitMs = (raw: string | undefined): number => {
  if (raw === undefined) return TERMINAL_WAIT_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return TERMINAL_WAIT_MS_DEFAULT;
  return Math.min(Math.trunc(parsed), TERMINAL_WAIT_MS_MAX);
};

/**
 * Validate a git ref-name component. Returns a human-readable error string or
 * null. Applies a strict subset of git-check-ref-format rules sufficient to
 * prevent ambiguous refs, traversal, and shell-injection via the branch name.
 */
export function validateGitRefName(name: string, field: string): string | null {
  if (!name) return `${field} must not be empty`;
  // Disallow whitespace, NUL, DEL, and git-special chars
  if (/[\x00-\x20\x7f ~^:?*[\\\]]/.test(name))
    return `${field} contains invalid characters`;
  if (name.includes("..")) return `${field} must not contain '..'`;
  if (name.includes("@{")) return `${field} must not contain '@{'`;
  if (name.includes("//")) return `${field} must not contain empty path segments ('//')`;
  if (name.startsWith("/")) return `${field} must not start with '/'`;
  if (name.startsWith(".")) return `${field} must not start with '.'`;
  if (name.endsWith(".")) return `${field} must not end with '.'`;
  if (name.endsWith("/")) return `${field} must not end with '/'`;
  if (name.endsWith(".lock")) return `${field} must not end with '.lock'`;
  if (name.startsWith("-")) return `${field} must not start with '-'`;
  // Path components must not start with '.'
  if (name.split("/").some((seg) => seg.startsWith(".")))
    return `${field} path components must not start with '.'`;
  return null;
}

/**
 * Validate a worktree subdirectory: must be a relative path with no traversal,
 * no empty segments, no absolute-path prefix, and no shell-significant chars.
 */
export function validateWorktreeSubdir(subdir: string): string | null {
  if (!subdir) return "worktreeSubdir must not be empty";
  if (isAbsolute(subdir)) return "worktreeSubdir must not be an absolute path";
  if (subdir.startsWith("~")) return "worktreeSubdir must not start with '~'";
  if (subdir.startsWith("/")) return "worktreeSubdir must not be an absolute path";
  const segments = subdir.split("/");
  for (const seg of segments) {
    if (seg === "") return "worktreeSubdir must not have empty path segments";
    if (seg === "..") return "worktreeSubdir must not contain traversal segments (..)";
    if (seg === ".") return "worktreeSubdir must not contain '.' segments";
    if (/[$`(){}<>|;&!#]/.test(seg))
      return "worktreeSubdir contains shell-significant characters";
  }
  return null;
}

/**
 * Map a service-layer AcpError onto the HTTP status the legacy routes used
 * for the equivalent failure, with the ACP code carried in the body so a
 * follow-up DBOS change can consume it (§22.10).
 */
function errorResponse(error: AcpError): {
  status: 400 | 404 | 409 | 422 | 503;
  body: { error: string; code: string; detail: string };
} {
  const body = { error: error.detail, code: error.code, detail: error.detail };
  switch (error.code) {
    case "session_key_conflict":
    case "delivery_key_conflict":
    case "session_busy":
    case "session_fenced":
      return { status: 409, body };
    case "session_not_found":
      return { status: 404, body };
    case "worktree_failed":
      return {
        status: 422,
        body: { ...body, error: "worktree could not be created", code: "worktree_create_failed" },
      };
    case "agent_profile_unavailable":
    case "requested_model_unsupported":
    case "requested_effort_unsupported":
      return { status: 400, body };
    default:
      return { status: 503, body };
  }
}

export interface SessionsRouteDeps {
  /** ACP session service — the production backend for every session route. */
  acp: AcpSessionService;
  /**
   * Read-only legacy manager for pre-cutover sessions: archived snapshot
   * listing and legacy purge. Never creates or spawns anything.
   */
  manager: SessionManager;
  /** Optional server default workdir (from --workdir CLI arg). */
  defaultWorkdir: string | null;
  /**
   * Oakridge base URL, used to ask whether a session is still held by a live
   * execution before honouring a close. Absent when Oakridge is not configured,
   * in which case no session is ever held.
   */
  oakridgeBaseUrl?: string;
}

/**
 * Registers the session routes — the DBOS-facing resumable contract (§11)
 * and the browser CRUD surface (§14.1/14.2/14.8) — against the ACP
 * session service.
 */
export function mountSessionsRoutes(app: Hono, deps: SessionsRouteDeps): void {
  const { acp, manager, defaultWorkdir, oakridgeBaseUrl } = deps;

  app.put("/sessions/resumable/:sessionKey", async (c) => {
    const rawKey = c.req.param("sessionKey").trim();
    if (rawKey.length === 0 || rawKey.length > 300) return c.json({ error: "session key must be 1-300 characters" }, 400);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return c.json({ error: "json body must be an object" }, 400);
    const body = raw as {
      initial_prompt?: unknown; workdir?: unknown; name?: unknown; artifact_id?: unknown;
      runtime?: unknown; model?: unknown; effort?: unknown; worktree?: unknown; inherit_worktree_from?: unknown;
    };
    if (typeof body.initial_prompt !== "string" || body.initial_prompt.trim() === "") return c.json({ error: "initial_prompt must be a non-empty string" }, 400);
    if (typeof body.workdir !== "string") return c.json({ error: "workdir must be a string" }, 400);
    const workdirError = await validateWorkdir(body.workdir);
    if (workdirError) return c.json({ error: workdirError }, 400);
    if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length > 80)) return c.json({ error: "name must be a string of at most 80 characters" }, 400);
    if (body.artifact_id !== undefined && (typeof body.artifact_id !== "string" || body.artifact_id.trim() === "" || body.artifact_id.trim().length > MAX_ARTIFACT_ID_LENGTH)) return c.json({ error: `artifact_id must be 1-${MAX_ARTIFACT_ID_LENGTH} characters` }, 400);
    if (body.runtime !== undefined && typeof body.runtime !== "string") return c.json({ error: "runtime must be a string" }, 400);
    if (body.model !== undefined && typeof body.model !== "string") return c.json({ error: "model must be a string" }, 400);
    if (body.effort !== undefined && typeof body.effort !== "string") return c.json({ error: "effort must be a string" }, 400);
    let worktree: AcpSessionStartSpec["worktree"];
    if (body.worktree !== undefined) {
      if (typeof body.worktree !== "object" || body.worktree === null || Array.isArray(body.worktree)) return c.json({ error: "worktree must be an object" }, 400);
      const value = body.worktree as { branch_name?: unknown; worktree_subdir?: unknown; base_ref?: unknown };
      if (typeof value.branch_name !== "string" || typeof value.worktree_subdir !== "string" || (value.base_ref !== undefined && typeof value.base_ref !== "string")) return c.json({ error: "worktree fields are invalid" }, 400);
      const branchErr = validateGitRefName(value.branch_name, "worktree.branch_name");
      if (branchErr) return c.json({ error: branchErr }, 400);
      const subdirErr = validateWorktreeSubdir(value.worktree_subdir);
      if (subdirErr) return c.json({ error: subdirErr }, 400);
      worktree = { branch_name: value.branch_name, worktree_subdir: value.worktree_subdir, ...(typeof value.base_ref === "string" ? { base_ref: value.base_ref } : {}) };
    }
    let inheritWorktreeFrom: string | undefined;
    if (body.inherit_worktree_from !== undefined) {
      if (typeof body.inherit_worktree_from !== "string" || !isValidSid(body.inherit_worktree_from.trim())) return c.json({ error: "inherit_worktree_from must be a valid session id" }, 400);
      inheritWorktreeFrom = body.inherit_worktree_from.trim();
    }
    if (worktree && inheritWorktreeFrom !== undefined) return c.json({ error: "worktree cannot be combined with inherit_worktree_from" }, 400);
    const startSpec: AcpSessionStartSpec = {
      initial_prompt: body.initial_prompt,
      workdir: resolve(body.workdir),
      ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
      ...(typeof body.artifact_id === "string" ? { artifact_id: body.artifact_id.trim() } : {}),
      ...(typeof body.runtime === "string" ? { runtime: body.runtime } : {}),
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
      ...(worktree ? { worktree } : {}),
      ...(inheritWorktreeFrom ? { inherit_worktree_from: inheritWorktreeFrom } : {}),
    };
    const ensured = await acp.ensureResumableSession(rawKey, startSpec);
    if (!ensured.ok) {
      const { status, body: errBody } = errorResponse(ensured.error);
      return c.json(errBody, status);
    }
    const snapshot = ensured.value.session;
    // Legacy kinds: a fresh session "started" (201); an existing live one
    // "attached"; an existing dead one "terminal" — the caller proceeds
    // straight to terminal observation.
    const kind =
      ensured.value.kind === "created"
        ? "started"
        : toLegacyStatus(snapshot.status) === "ended"
          ? "terminal"
          : "attached";
    return c.json(
      { kind, session: toLegacySnapshot(snapshot) },
      kind === "started" ? 201 : 200,
    );
  });

  // Escape hatch for a key whose session can no longer make progress
  // (§10.6). Explicit, operator-driven, and never reachable by an ensure
  // retry — advancing on its own would start a second agent for work that
  // may still be running.
  app.post("/sessions/resumable/:sessionKey/advance", async (c) => {
    const rawKey = c.req.param("sessionKey").trim();
    if (rawKey.length === 0 || rawKey.length > 300) return c.json({ error: "session key must be 1-300 characters" }, 400);
    const result = await acp.advanceResumable(rawKey);
    if (result.kind === "not_found") return c.json({ error: "session key has never been claimed" }, 404);
    return c.json({ kind: "advanced", session: toLegacySnapshot(result.session) });
  });

  // Bounded long-poll (§11.2). `wait_ms` is capped well under the server's
  // idle timeout so the socket is never severed mid-wait; a still-running
  // initial turn answers 202 and the observer polls again.
  app.get("/sessions/resumable/:sid/terminal", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    const waitMs = selectTerminalWaitMs(c.req.query("wait_ms"));
    const observed = await acp.observeInitialTurn(sid, waitMs);
    if (!observed.ok) {
      const { status, body: errBody } = errorResponse(observed.error);
      return c.json(errBody, status);
    }
    if (observed.value.kind === "pending") {
      return c.json(
        { pending: true, session: toLegacySnapshot(observed.value.session) },
        202,
      );
    }
    return c.json(toTerminalBody(observed.value));
  });

  app.put("/sessions/resumable/:sid/input/:deliveryKey", async (c) => {
    const sid = c.req.param("sid");
    const deliveryKey = c.req.param("deliveryKey").trim();
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    if (deliveryKey.length === 0 || deliveryKey.length > 300) return c.json({ error: "delivery key must be 1-300 characters" }, 400);
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("text" in raw) || typeof raw.text !== "string" || raw.text.trim() === "") return c.json({ error: "text must be a non-empty string" }, 400);
    const delivered = await acp.sendInput(sid, raw.text.trim(), { delivery_key: deliveryKey });
    if (!delivered.ok) {
      const { status, body: errBody } = errorResponse(delivered.error);
      return c.json(errBody, status);
    }
    return c.json({ accepted: true, delivery_key: delivered.value.turn_key, status: delivered.value.status });
  });

  app.get("/sessions", async (c) => {
    const acpSessions = listPwaSessions(acp);
    const include = c.req.query("include");
    if (include !== "archived") return c.json({ sessions: acpSessions });
    // Pre-cutover sessions live as JSONL; keep them listed (closed, not
    // viewable) until the legacy machinery is deleted. Ordered newest
    // first by lastActivityTs so the PWA can render without a second sort.
    const archived = await manager.listArchivedSnapshots();
    const legacy = [...manager.listSnapshots(), ...archived].map(
      archivedLegacyToPwaSnapshot,
    );
    const merged = [...acpSessions, ...legacy].sort((a, b) => {
      if (a.lastActivityTs === b.lastActivityTs) return 0;
      return a.lastActivityTs < b.lastActivityTs ? 1 : -1;
    });
    return c.json({ sessions: merged });
  });

  app.post("/sessions", async (c) => {
    let raw: unknown = null;
    try {
      const bodyText = await c.req.text();
      if (bodyText !== "") raw = JSON.parse(bodyText);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
      return c.json({ error: "json body must be an object" }, 400);
    }
    const parsed = (raw ?? {}) as {
      resume_from?: unknown;
      workdir?: unknown;
      name?: unknown;
      artifact_id?: unknown;
      model?: unknown;
      effort?: unknown;
      runtime?: unknown;
      agent_profile?: unknown;
      worktree?: unknown;
    };

    // `runtime` remains the wire alias for `agent_profile` during the
    // migration (§14.2); both are accepted, conflicts rejected.
    if (parsed.runtime !== undefined && typeof parsed.runtime !== "string") {
      return c.json({ error: "runtime must be a string" }, 400);
    }
    if (parsed.agent_profile !== undefined && typeof parsed.agent_profile !== "string") {
      return c.json({ error: "agent_profile must be a string" }, 400);
    }
    if (
      typeof parsed.runtime === "string" &&
      typeof parsed.agent_profile === "string" &&
      parsed.runtime !== parsed.agent_profile
    ) {
      return c.json({ error: "runtime and agent_profile conflict" }, 400);
    }
    const profileId = (parsed.agent_profile ?? parsed.runtime) as string | undefined;

    let name: string | undefined;
    if (parsed.name !== undefined) {
      if (typeof parsed.name !== "string") return c.json({ error: "name must be a string" }, 400);
      const trimmed = parsed.name.trim();
      if (trimmed.length > 80) return c.json({ error: "name must be ≤ 80 chars after trimming" }, 400);
      name = trimmed.length > 0 ? trimmed : undefined;
    }
    let artifactId: string | undefined;
    if (parsed.artifact_id !== undefined) {
      if (typeof parsed.artifact_id !== "string") return c.json({ error: "artifact_id must be a string" }, 400);
      const trimmed = parsed.artifact_id.trim();
      if (trimmed === "") return c.json({ error: "artifact_id must be non-empty when provided" }, 400);
      if (trimmed.length > MAX_ARTIFACT_ID_LENGTH) return c.json({ error: `artifact_id must be ≤ ${MAX_ARTIFACT_ID_LENGTH} chars after trimming` }, 400);
      artifactId = trimmed;
    }
    let model: string | undefined;
    if (parsed.model !== undefined) {
      if (typeof parsed.model !== "string" || parsed.model.trim() === "") return c.json({ error: "model must be a non-empty string" }, 400);
      model = parsed.model.trim();
    }
    let effort: string | undefined;
    if (parsed.effort !== undefined) {
      if (typeof parsed.effort !== "string" || parsed.effort.trim() === "") return c.json({ error: "effort must be a non-empty string" }, 400);
      effort = parsed.effort.trim();
    }

    let resumeFrom: string | undefined;
    if (parsed.resume_from !== undefined) {
      if (typeof parsed.resume_from !== "string" || !isValidSid(parsed.resume_from)) {
        return c.json({ error: "invalid resume_from" }, 400);
      }
      resumeFrom = parsed.resume_from;
    }

    let worktree: AcpSessionStartSpec["worktree"];
    if (parsed.worktree !== undefined) {
      if (resumeFrom !== undefined) return c.json({ error: "worktree cannot be combined with resume_from" }, 400);
      if (typeof parsed.worktree !== "object" || parsed.worktree === null || Array.isArray(parsed.worktree)) {
        return c.json({ error: "worktree must be an object" }, 400);
      }
      const wt = parsed.worktree as { branchName?: unknown; worktreeSubdir?: unknown; baseRef?: unknown };
      if (typeof wt.branchName !== "string") return c.json({ error: "worktree.branchName must be a string" }, 400);
      if (typeof wt.worktreeSubdir !== "string") return c.json({ error: "worktree.worktreeSubdir must be a string" }, 400);
      const branchErr = validateGitRefName(wt.branchName, "worktree.branchName");
      if (branchErr) return c.json({ error: branchErr }, 400);
      const subdirErr = validateWorktreeSubdir(wt.worktreeSubdir);
      if (subdirErr) return c.json({ error: subdirErr }, 400);
      if (wt.baseRef !== undefined) {
        if (typeof wt.baseRef !== "string") return c.json({ error: "worktree.baseRef must be a string when provided" }, 400);
        const baseRefErr = validateGitRefName(wt.baseRef, "worktree.baseRef");
        if (baseRefErr) return c.json({ error: baseRefErr }, 400);
      }
      worktree = {
        branch_name: wt.branchName,
        worktree_subdir: wt.worktreeSubdir,
        ...(typeof wt.baseRef === "string" ? { base_ref: wt.baseRef } : {}),
      };
    }

    let workdir: string;
    if (resumeFrom !== undefined) {
      // Worktree inheritance is the resume mechanism (§17.3): the child
      // runs in a fresh worktree cut from the parent's. The parent
      // supplies the workdir; a body workdir would be ignored anyway.
      const parent = acp.getSession(resumeFrom);
      if (!parent) return c.json({ error: "unknown resume_from session" }, 404);
      workdir = parent.worktree_path;
    } else {
      const requested = typeof parsed.workdir === "string" ? parsed.workdir : defaultWorkdir;
      if (typeof parsed.workdir !== "undefined" && typeof parsed.workdir !== "string") {
        return c.json({ error: "workdir must be a string" }, 400);
      }
      if (requested === null || requested === undefined) {
        return c.json({ error: "workdir is required" }, 400);
      }
      const workdirErr = await validateWorkdir(requested);
      if (workdirErr) return c.json({ error: workdirErr }, 400);
      workdir = resolve(requested);
    }

    const created = await acp.createSession({
      initial_prompt: "",
      workdir,
      ...(name ? { name } : {}),
      ...(artifactId ? { artifact_id: artifactId } : {}),
      ...(profileId ? { runtime: profileId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(worktree ? { worktree } : {}),
      ...(resumeFrom ? { inherit_worktree_from: resumeFrom } : {}),
    });
    if (!created.ok) {
      const { status, body: errBody } = errorResponse(created.error);
      return c.json(errBody, status);
    }
    return c.json(
      toPwaSessionSnapshot(
        created.value,
        acp.pendingPermissionCount(created.value.sid),
      ),
    );
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
        { error: `artifactId must be ≤ ${MAX_ARTIFACT_ID_LENGTH} chars after trimming` },
        400,
      );
    }
    const acpSessions = acp
      .listByArtifact(trimmed)
      .map((session) =>
        toPwaSessionSnapshot(session, acp.pendingPermissionCount(session.sid)),
      );
    const legacy = manager
      .listByArtifact(trimmed as ArtifactId)
      .map(archivedLegacyToPwaSnapshot);
    return c.json({ sessions: [...acpSessions, ...legacy] });
  });

  app.delete("/sessions/:sid", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    const purge = isTruthyFlag(c.req.query("purge"));
    // A close is refused while a live execution still depends on this session
    // — unless it is that execution fencing itself, or an operator who has
    // seen the refusal and asked again.
    const authority = selectCloseAuthority({ force: c.req.query("force"), fenced_by: c.req.query("fenced_by") });
    if (authority.kind !== "operator_override") {
      const refusal = selectCloseRefusal(authority, await findSessionHold(sid, { baseUrl: oakridgeBaseUrl }));
      if (refusal) return c.json(refusal, 409);
    }

    const acpSession = acp.getSession(sid);
    if (acpSession) {
      const fencedBy = c.req.query("fenced_by");
      if (purge) {
        const purged = await acp.purgeSession(sid);
        if (!purged.ok) {
          const { status, body: errBody } = errorResponse(purged.error);
          return c.json(errBody, status);
        }
        return c.json({ ok: true, removed: purged.value });
      }
      const closed = await acp.closeSession(
        sid,
        fencedBy ? { fenced_by: fencedBy } : undefined,
      );
      if (!closed.ok) {
        const { status, body: errBody } = errorResponse(closed.error);
        return c.json(errBody, status);
      }
      return c.json({ ok: true });
    }

    // Legacy fallback: archived pre-cutover sessions still support purge.
    if (purge) {
      const removed = await manager.remove(sid);
      if (!removed) return c.json({ error: "unknown session" }, 404);
      return c.json({ ok: true, removed: true });
    }
    return c.json({ error: "unknown session" }, 404);
  });
}

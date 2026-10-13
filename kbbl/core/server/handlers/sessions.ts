import type { Hono } from "hono";
import { isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";

/**
 * Hard cap on `artifactId` length, enforced at POST /sessions and
 * GET /artifacts/:artifactId/sessions.
 */
const MAX_ARTIFACT_ID_LENGTH = 200;
import type { AcpSessionService } from "../../acp/session-service";
import type { AcpError, AcpSessionSnapshot, AcpSessionStartSpec, AcpSessionStatus, AcpSessionWorkflowIdentity, TerminalObservation } from "../../acp/types";
import { toPwaSessionSnapshot } from "../../acp/pwa-wire";
import type { ResumableEnd, ResumableEnsureRequest, ResumableEnsureResponse, ResumablePendingBody, ResumableSessionSnapshot, ResumableSessionStatus, ResumableTerminalBody, ResumableWorkflowIdentity } from "../../acp/resumable-wire";
import { buildResumeContext } from "../../acp/resume-context";
import { listPwaSessions } from "./acp-inbox";
import { isValidSid } from "./acp-per-sid";
import { findSessionHold, isTruthyFlag, selectCloseAuthority, selectCloseRefusal } from "../session-hold";

// HTTP response projections for the resumable ACP session API (acp/resumable-wire.ts).
function toResumableStatus(status: AcpSessionStatus): ResumableSessionStatus {
  switch (status) {
    case "provisioning":
      return "starting";
    case "idle":
    case "prompting":
    // An unknown session's turn outcome is uncertain, but the session
    // itself is still attached: reporting "ended" would make the executor
    // read an outcome before observation says so.
    case "unknown":
      return "live";
    case "ended":
    case "fenced":
    case "failed":
      return "ended";
  }
}

function toResumableSnapshot(snapshot: AcpSessionSnapshot): ResumableSessionSnapshot {
  return {
    sid: snapshot.sid,
    name: snapshot.name,
    status: toResumableStatus(snapshot.status),
    createdAt: snapshot.created_at,
    lastActivityTs: snapshot.last_activity_at,
    runtimeId: snapshot.agent_profile,
    model: snapshot.requested_model,
    effort: snapshot.requested_effort,
    artifactId: snapshot.artifact_id,
    projectWorkdir: snapshot.project_workdir,
    worktreePath: snapshot.worktree_path,
    worktreeBranch: snapshot.worktree_branch,
    worktreeBaseRef: snapshot.worktree_base_ref,
  };
}

/** A session closed by an operator or by the attempt that holds it ended by closing; anything else that did not succeed failed. */
function toResumableEnd(observation: Exclude<TerminalObservation, { kind: "pending" }>): ResumableEnd {
  if (observation.kind === "succeeded") return { kind: "succeeded" };
  const session = observation.session;
  if (session.status === "fenced" || session.end_reason === "user_closed" || session.end_reason === "fenced") return { kind: "closed" };
  return { kind: "failed", code: observation.failure_code, detail: observation.failure_detail };
}

/** §11.2 terminal-route body for a non-pending observation. */
function toTerminalBody(observation: Exclude<TerminalObservation, { kind: "pending" }>): ResumableTerminalBody {
  return { session: toResumableSnapshot(observation.session), end: toResumableEnd(observation) };
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
 * Which agent, model and effort a POST /sessions body asked for. `undefined`
 * means the body said nothing — the distinction that makes resume
 * inheritance possible.
 */
export interface RequestedRuntimeSelection {
  readonly agent_profile: string | undefined;
  readonly model: string | undefined;
  readonly effort: string | undefined;
}

/** The parent fields a resumed child inherits its runtime selection from. */
export interface ResumeParentSelection {
  readonly agent_profile: string;
  readonly requested_model: string | null;
  readonly requested_effort: string | null;
}

/**
 * Resume (§17.3) continues a session's work in a fresh worktree, so the
 * child runs the parent's agent, model and effort unless the request names
 * its own. The PWA's resume button posts nothing but `resume_from`; before
 * this, the child fell through to `config.default_agent` with a null model,
 * so resuming a Codex/gpt-6-astra session handed back a Claude Code session
 * on whatever that agent defaults to. Worktree inheritance without runtime
 * inheritance is not a resume.
 *
 * An explicit body value always wins — switching agent mid-lineage stays
 * possible, it just is not the default. A model or effort id belongs to the
 * agent that advertised it (`gpt-6-astra` means nothing to Claude Code), so
 * naming a different agent without naming a model inherits nothing: the child
 * takes that agent's own defaults rather than provisioning straight into
 * `requested_model_unsupported`.
 */
export function resolveResumedRuntimeSelection(
  requested: RequestedRuntimeSelection,
  parent: ResumeParentSelection,
): RequestedRuntimeSelection {
  const switchesAgent =
    requested.agent_profile !== undefined &&
    requested.agent_profile !== parent.agent_profile;
  const inherited = <T>(parentValue: T | null): T | undefined =>
    switchesAgent ? undefined : parentValue ?? undefined;

  return {
    agent_profile: requested.agent_profile ?? parent.agent_profile,
    model: requested.model ?? inherited(parent.requested_model),
    effort: requested.effort ?? inherited(parent.requested_effort),
  };
}

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
 * Parses the optional `workflow` member of a resumable ensure body: the run,
 * unit and worker of the Oakridge attempt the session serves. Absence is not
 * an error (most sessions carry no workflow identity); it maps to null.
 */
export function parseWorkflowIdentity(
  raw: unknown,
): { value: AcpSessionWorkflowIdentity | null } | { error: string } {
  if (raw === undefined) return { value: null };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "workflow must be an object" };
  }
  const value = raw as { readonly [Field in keyof ResumableWorkflowIdentity]?: unknown };
  const fields = { run_id: value.run_id, unit_id: value.unit_id, worker: value.worker };
  for (const [name, field] of Object.entries(fields)) {
    if (typeof field !== "string" || field.trim() === "") return { error: `workflow.${name} must be a non-empty string` };
    if (field.trim().length > 200) return { error: `workflow.${name} must be at most 200 characters` };
  }
  return { value: { run_id: (fields.run_id as string).trim(), unit_id: (fields.unit_id as string).trim(), worker: (fields.worker as string).trim() } };
}

/** A service-layer AcpError as an HTTP status, with the ACP code carried in the body. */
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
  /** Optional server default workdir (from --workdir CLI arg). */
  defaultWorkdir: string | null;
  /**
   * Oakridge base URL, used to ask whether a running attempt still holds a
   * session before honouring a close. Absent when Oakridge is not configured,
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
  const { acp, defaultWorkdir, oakridgeBaseUrl } = deps;

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
    const body = raw as { readonly [Field in keyof ResumableEnsureRequest]?: unknown };
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
      const value = body.worktree as { readonly [Field in keyof NonNullable<ResumableEnsureRequest["worktree"]>]?: unknown };
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
    const workflowResult = parseWorkflowIdentity(body.workflow);
    if ("error" in workflowResult) return c.json({ error: workflowResult.error }, 400);
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
    let ensured = await acp.ensureResumableSession(rawKey, startSpec, workflowResult.value);
    if (ensured.ok && (ensured.value.session.status === "ended" || ensured.value.session.status === "failed" || ensured.value.session.status === "fenced")
      && c.req.header("x-oakridge-collaboration-resume") === "true") {
      const revived = await acp.reviveResumable(rawKey);
      ensured = revived.ok ? { ok: true, value: { kind: "existing", session: revived.value } } : revived;
    }
    if (!ensured.ok) {
      const { status, body: errBody } = errorResponse(ensured.error);
      return c.json(errBody, status);
    }
    const snapshot = ensured.value.session;
    // A fresh session "started" (201); an existing live one
    // "attached"; an existing dead one "terminal" — the caller proceeds
    // straight to terminal observation.
    const kind =
      ensured.value.kind === "created"
        ? "started"
        : toResumableStatus(snapshot.status) === "ended"
          ? "terminal"
          : "attached";
    const response: ResumableEnsureResponse = { kind, session: toResumableSnapshot(snapshot) };
    return c.json(response, kind === "started" ? 201 : 200);
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
    return c.json({ kind: "advanced", session: toResumableSnapshot(result.session) });
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
      const pending: ResumablePendingBody = { pending: true, session: toResumableSnapshot(observed.value.session) };
      return c.json(pending, 202);
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

  app.get("/sessions", (c) => c.json({ sessions: listPwaSessions(acp) }));

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
      worktree?: unknown;
    };

    // `runtime` names the agent profile (§14.2).
    if (parsed.runtime !== undefined && typeof parsed.runtime !== "string") {
      return c.json({ error: "runtime must be a string" }, 400);
    }
    const profileId = parsed.runtime;

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

    let selection: RequestedRuntimeSelection = {
      agent_profile: profileId,
      model,
      effort,
    };

    let workdir: string;
    let initialPrompt = "";
    if (resumeFrom !== undefined) {
      // Worktree inheritance is the resume mechanism (§17.3): the child
      // runs in a fresh worktree cut from the parent's. The parent
      // supplies the workdir; a body workdir would be ignored anyway.
      const parent = acp.getSession(resumeFrom);
      if (!parent) return c.json({ error: "unknown resume_from session" }, 404);
      workdir = parent.worktree_path;
      selection = resolveResumedRuntimeSelection(selection, parent);
      const history = await acp.loadResumeHistory(resumeFrom, c.req.raw.signal);
      if (!history.ok) {
        const { status, body: errBody } = errorResponse(history.error);
        return c.json(errBody, status);
      }
      if (c.req.raw.signal.aborted) return c.json({ error: "resume request was cancelled" }, 408);
      if (history.value.kind === "unavailable") {
        return c.json({ error: "previous session history is unavailable; resume would lose its context" }, 409);
      }
      initialPrompt = buildResumeContext(resumeFrom, history.value);
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
      initial_prompt: initialPrompt,
      workdir,
      ...(name ? { name } : {}),
      ...(artifactId ? { artifact_id: artifactId } : {}),
      ...(selection.agent_profile ? { runtime: selection.agent_profile } : {}),
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.effort ? { effort: selection.effort } : {}),
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
    return c.json({ sessions: acp.listByArtifact(trimmed)
      .map((session) => toPwaSessionSnapshot(session, acp.pendingPermissionCount(session.sid))) });
  });

  app.delete("/sessions/:sid", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
    const purge = isTruthyFlag(c.req.query("purge"));
    // A close is refused while a running Oakridge attempt still uses this
    // session, unless it is that attempt closing it or an operator who has
    // seen the refusal and asked again.
    const authority = selectCloseAuthority({ force: c.req.query("force"), fenced_by: c.req.query("fenced_by"), closed_by: c.req.query("closed_by") });
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
    return c.json({ error: "unknown session" }, 404);
  });
}

import type { ExecutionRequest, ExecutorAdapter, ExecutorObservationAttempt, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import type { ExecutionAttemptId, ExecutionId, JsonValue } from "../domain/primitives";

/**
 * How long kbbl may hold one observation request open. Well under kbbl's own
 * 255s socket deadline, so a poll always returns an answer rather than being
 * severed mid-flight and burning the step's retry budget.
 */
const DEFAULT_OBSERVE_WAIT_MS = 25_000;

const terminal = (observation: ExecutorTerminalObservation): ExecutorObservationAttempt => ({ kind: "terminal", observation });

interface KbblResolvedConfig {
  readonly runtime: "claude-code" | "codex";
  readonly rendered_prompt: string;
  readonly workdir: string;
  readonly session_name: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly artifact_id: string | null;
  readonly worktree: { readonly branchName: string; readonly worktreeSubdir: string; readonly baseRef?: string } | null;
}

interface KbblSessionSummary {
  readonly sid: string;
  readonly status: "starting" | "live" | "compacting" | "ended";
  readonly endReason: "user_closed" | "subprocess_exited" | "compacted" | null;
}

interface EnsureSessionResponse {
  readonly kind: "attached" | "started" | "terminal";
  readonly session: KbblSessionSummary;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const isObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } => typeof value === "object" && value !== null && !Array.isArray(value);

const parseResolvedConfig = (value: JsonValue): KbblResolvedConfig => {
  if (!isObject(value)) throw new Error("kbbl resolved config must be an object");
  const runtime = value.runtime;
  const renderedPrompt = value.rendered_prompt;
  const workdir = value.workdir;
  const sessionName = value.session_name;
  if ((runtime !== "claude-code" && runtime !== "codex") || typeof renderedPrompt !== "string" || typeof workdir !== "string" || typeof sessionName !== "string") {
    throw new Error("kbbl resolved config is missing required fields");
  }
  const model = typeof value.model === "string" ? value.model : null;
  const effort = typeof value.effort === "string" ? value.effort : null;
  const artifactId = typeof value.artifact_id === "string" ? value.artifact_id : null;
  const rawWorktree = value.worktree;
  let worktree: KbblResolvedConfig["worktree"] = null;
  if (rawWorktree !== undefined) {
    if (!isObject(rawWorktree) || typeof rawWorktree.branchName !== "string" || typeof rawWorktree.worktreeSubdir !== "string"
      || (rawWorktree.baseRef !== undefined && typeof rawWorktree.baseRef !== "string")) throw new Error("kbbl resolved worktree config is invalid");
    worktree = { branchName: rawWorktree.branchName, worktreeSubdir: rawWorktree.worktreeSubdir,
      ...(typeof rawWorktree.baseRef === "string" ? { baseRef: rawWorktree.baseRef } : {}) };
  }
  return { runtime, rendered_prompt: renderedPrompt, workdir, session_name: sessionName, model, effort, artifact_id: artifactId, worktree };
};

const parseEnsureResponse = (value: unknown): EnsureSessionResponse => {
  if (typeof value !== "object" || value === null || !("kind" in value) || !("session" in value)) throw new Error("invalid kbbl ensure-session response");
  const kind = value.kind;
  const session = value.session;
  if ((kind !== "attached" && kind !== "started" && kind !== "terminal") || typeof session !== "object" || session === null || !("sid" in session) || typeof session.sid !== "string" || !("status" in session)) {
    throw new Error("invalid kbbl ensure-session response");
  }
  const status = session.status;
  if (status !== "starting" && status !== "live" && status !== "compacting" && status !== "ended") throw new Error("invalid kbbl session status");
  const endReason = "endReason" in session && (session.endReason === "user_closed" || session.endReason === "subprocess_exited" || session.endReason === "compacted") ? session.endReason : null;
  return { kind, session: { sid: session.sid, status, endReason } };
};

export interface KbblExecutorAdapterOptions {
  readonly base_url: string;
  readonly executor_function_identity: string;
  readonly observe_wait_ms?: number;
  readonly fetch?: FetchLike;
}

/**
 * The kbbl session one attempt owns. Keying on the attempt rather than the
 * execution is what lets a rerun start a fresh agent: the execution id is
 * shared by every attempt, so a rerun keyed on it resolved to the session that
 * had already died and re-failed immediately. The application version stays in
 * the key so a session never spans a backend version change.
 */
const sessionKeyFor = (attempt_id: ExecutionAttemptId, executor_function_identity: string): string =>
  `${attempt_id}:${executor_function_identity}`;

const sessionIdOf = (external_reference: ExternalExecutionReference, execution_id: ExecutionId): string => {
  if (external_reference.kind !== "kbbl_session") throw new Error(`execution ${execution_id} has no kbbl session reference`);
  return external_reference.session_id;
};

export class KbblExecutorAdapter implements ExecutorAdapter {
  readonly executor_type = "delegated_session";
  private readonly fetch: FetchLike;

  constructor(private readonly options: KbblExecutorAdapterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async start_or_attach(request: ExecutionRequest, attempt_id: ExecutionAttemptId): Promise<ExternalExecutionReference> {
    const config = parseResolvedConfig(request.resolved_config);
    const inheritedSessionId = request.workspace_source?.external_reference.kind === "kbbl_session"
      ? request.workspace_source.external_reference.session_id : null;
    // Definition-time validation should have caught this; failing here keeps the
    // message actionable instead of surfacing as an opaque kbbl 400.
    if (config.worktree && inheritedSessionId) {
      throw new Error(`execution ${request.execution_id} resolves its own worktree and inherits one from ${inheritedSessionId}; these are mutually exclusive`);
    }
    const sessionKey = sessionKeyFor(attempt_id, this.options.executor_function_identity);
    const response = await this.fetch(`${this.options.base_url}/sessions/resumable/${encodeURIComponent(sessionKey)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initial_prompt: config.rendered_prompt,
        workdir: config.workdir,
        name: config.session_name,
        runtime: config.runtime,
        ...(config.model ? { model: config.model } : {}),
        ...(config.effort ? { effort: config.effort } : {}),
        ...(config.artifact_id ? { artifact_id: config.artifact_id } : {}),
        ...(config.worktree ? { worktree: { branch_name: config.worktree.branchName, worktree_subdir: config.worktree.worktreeSubdir,
          ...(config.worktree.baseRef ? { base_ref: config.worktree.baseRef } : {}) } } : {}),
        ...(inheritedSessionId ? { inherit_worktree_from: inheritedSessionId } : {}),
      }),
    });
    if (!response.ok) throw new Error(`kbbl ensure-session failed (${response.status}): ${await response.text()}`);
    const ensured = parseEnsureResponse(await response.json());
    return { kind: "kbbl_session", session_id: ensured.session.sid };
  }

  async observe_terminal(execution_id: ExecutionId, external_reference: ExternalExecutionReference): Promise<ExecutorObservationAttempt> {
    // Reported as a failure rather than thrown, unlike `cancel_or_fence` below.
    // This is the only path by which a unit can ever be reported terminal, and
    // it runs inside a retrying step: throwing exhausts the retries, kills the
    // terminal observer, and leaves the execution waiting on a message that can
    // now never arrive — a silent stall an operator has to go hunting for.
    // A named failure code parks the unit for rerun and says what happened.
    if (external_reference.kind !== "kbbl_session") return terminal({ kind: "failed", code: "session_not_ensured", detail: `no kbbl session is associated with execution ${execution_id}` });
    const sessionId = external_reference.session_id;
    const url = `${this.options.base_url}/sessions/resumable/${encodeURIComponent(sessionId)}/terminal?wait_ms=${this.options.observe_wait_ms ?? DEFAULT_OBSERVE_WAIT_MS}`;
    const response = await this.fetch(url);
    if (response.status === 202) return { kind: "pending" };
    if (!response.ok) return terminal({ kind: "failed", code: "terminal_observation_failed", detail: `kbbl terminal observation failed (${response.status}): ${await response.text()}` });
    const raw = await response.json();
    if (typeof raw !== "object" || raw === null || !("session" in raw) || typeof raw.session !== "object" || raw.session === null || !("endReason" in raw.session)) {
      return terminal({ kind: "failed", code: "invalid_terminal_response", detail: "kbbl returned an invalid terminal response" });
    }
    if (raw.session.endReason === "user_closed") return terminal({ kind: "cancelled", detail: "kbbl session was closed" });
    const exitCode = "exit_code" in raw && typeof raw.exit_code === "number" ? raw.exit_code : null;
    // Success must be positively established. A session whose exit code kbbl
    // cannot report — it crashed before writing one, or predates exit-code
    // reconstruction — is reported as failed, not assumed clean: treating an
    // unknown code as success strands the execution waiting for artifacts a
    // dead runtime will never emit, with nothing visible to the operator.
    if (exitCode === null) return terminal({ kind: "failed", code: "exit_unknown", detail: `kbbl session ${sessionId} ended without a recorded exit code` });
    if (exitCode !== 0) return terminal({ kind: "failed", code: "executor_exit_nonzero", detail: `kbbl runtime exited with code ${exitCode}` });
    return terminal({ kind: "succeeded", metadata: { session_id: sessionId, exit_code: exitCode } });
  }

  async cancel_or_fence(execution_id: ExecutionId, external_reference: ExternalExecutionReference): Promise<void> {
    // `none` is the honest answer for an execution that never reached an
    // executor; anything else means the reference was lost, which must fail
    // loudly rather than leave a live agent running unfenced.
    if (external_reference.kind === "none") return;
    const sessionId = sessionIdOf(external_reference, execution_id);
    // Identify the fence as coming from the execution that holds the session.
    // kbbl refuses closes that would abandon a live unit, and that guard must
    // not fire on the owner's own teardown: a cancelled run reaches its agent
    // through exactly this call, so an unqualified DELETE deadlocks the run
    // against itself — uncancellable because it is still active.
    const url = `${this.options.base_url}/sessions/${encodeURIComponent(sessionId)}?fenced_by=${encodeURIComponent(execution_id)}`;
    const response = await this.fetch(url, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`kbbl cancellation failed (${response.status}): ${await response.text()}`);
  }

  async deliver_input(execution_id: ExecutionId, delivery_key: string, input: string, external_reference: ExternalExecutionReference): Promise<void> {
    const sessionId = sessionIdOf(external_reference, execution_id);
    const response = await this.fetch(`${this.options.base_url}/sessions/resumable/${encodeURIComponent(sessionId)}/input/${encodeURIComponent(delivery_key)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: input }),
    });
    if (!response.ok) throw new Error(`kbbl input delivery failed (${response.status}): ${await response.text()}`);
  }
}

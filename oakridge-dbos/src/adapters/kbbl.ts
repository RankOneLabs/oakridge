import type { ExecutionRequest, ExecutorAdapter, ExecutorObservationAttempt, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import type { ExecutionId, ExecutorOperationId, JsonValue } from "../domain/primitives";

/**
 * How long kbbl may hold one observation request open. Well under kbbl's own
 * 255s socket deadline, so a poll always returns an answer rather than being
 * severed mid-flight and burning the step's retry budget.
 */
const DEFAULT_OBSERVE_WAIT_MS = 25_000;

/**
 * How long a session may report no activity at all before it is called dead.
 *
 * Not a cap on how long an agent may work — `lastActivityTs` moves on every
 * event a session produces, so a busy agent never approaches this. It bounds
 * the case with no other bound: a session that started, never took its first
 * turn, and will therefore never end. kbbl answers "not terminal" for such a
 * session forever, truthfully, and before this the observer believed it
 * forever.
 *
 * Generous on purpose. A tool call that runs for a long time without emitting
 * anything — a full test suite, a slow build — is silent from the outside, and
 * killing that would be a worse failure than the stall this prevents.
 */
const DEFAULT_MAX_SILENT_MS = 30 * 60_000;

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
  readonly publication: { readonly base_url: string; readonly work_order_id: string; readonly capability: string } | null;
}

interface KbblSessionSummary {
  readonly sid: string;
  readonly status: "starting" | "live" | "compacting" | "ended";
  readonly endReason: "user_closed" | "subprocess_exited" | "compacted" | null;
  readonly worktreeBaseRef: string | null;
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
  const rawPublication = value.publication;
  const publication = isObject(rawPublication) && typeof rawPublication.base_url === "string" && typeof rawPublication.work_order_id === "string" && typeof rawPublication.capability === "string"
    ? { base_url: rawPublication.base_url, work_order_id: rawPublication.work_order_id, capability: rawPublication.capability } : null;
  return { runtime, rendered_prompt: renderedPrompt, workdir, session_name: sessionName, model, effort, artifact_id: artifactId, worktree, publication };
};

const publicationInstructions = (config: KbblResolvedConfig): string => config.publication ? `\n\n## Oakridge v2 artifact publication\n\nUse this run-owned endpoint instead of any stage/execution emit URL shown earlier:\n\nPUT ${config.publication.base_url.replace(/\/$/, "")}/work-orders/${config.publication.work_order_id}/emit/<output-name>\nWork-Order-Capability: ${config.publication.capability}\nIdempotency-Key: <stable key for this output payload>\nContent-Type: application/json\n\nFor a collection member, also send Output-Collection-Key. A successful executor exit does not satisfy the unit; publish every required output.\n` : "";

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
  const worktreeBaseRef = "worktreeBaseRef" in session && typeof session.worktreeBaseRef === "string" ? session.worktreeBaseRef : null;
  return { kind, session: { sid: session.sid, status, endReason, worktreeBaseRef } };
};

/** Oakridge branch bases always mean the freshly observed remote branch. */
export const selectRemoteWorktreeBase = (baseRef: string): string => {
  if (baseRef.startsWith("origin/") || /^[0-9a-f]{40}$/.test(baseRef)) return baseRef;
  return `origin/${baseRef}`;
};

export interface KbblExecutorAdapterOptions {
  readonly base_url: string;
  readonly executor_function_identity: string;
  readonly observe_wait_ms?: number;
  /** Silence after which a session is failed rather than polled forever. */
  readonly max_silent_ms?: number;
  /** Injectable clock, so a test can prove the bound without waiting it out. */
  readonly now?: () => number;
  readonly fetch?: FetchLike;
}

/**
 * How long a pending session has been silent, or null when kbbl did not say.
 *
 * Absent or unparseable activity is deliberately *not* treated as silence: an
 * older kbbl that omits the field would otherwise have every one of its
 * sessions failed at the first poll.
 */
export const silentDurationMs = (pending: JsonValue, now: number): number | null => {
  if (!isObject(pending)) return null;
  const session = pending.session;
  if (!isObject(session)) return null;
  const lastActivity = session.lastActivityTs;
  if (typeof lastActivity !== "string") return null;
  const observedAt = Date.parse(lastActivity);
  if (Number.isNaN(observedAt)) return null;
  return Math.max(0, now - observedAt);
};

/**
 * The kbbl session one attempt owns. Keying on the attempt rather than the
 * execution is what lets a rerun start a fresh agent: the execution id is
 * shared by every attempt, so a rerun keyed on it resolved to the session that
 * had already died and re-failed immediately. The application version stays in
 * the key so a session never spans a backend version change.
 */
const sessionKeyFor = (operation_id: ExecutorOperationId, executor_function_identity: string): string =>
  `${operation_id}:${executor_function_identity}`;

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

  async start_or_attach(request: ExecutionRequest, operation_id: ExecutorOperationId): Promise<ExternalExecutionReference> {
    const config = parseResolvedConfig(request.resolved_config);
    const inheritedSessionId = request.workspace_source?.external_reference.kind === "kbbl_session"
      ? request.workspace_source.external_reference.session_id : null;
    // Definition-time validation should have caught this; failing here keeps the
    // message actionable instead of surfacing as an opaque kbbl 400.
    if (config.worktree && inheritedSessionId) {
      throw new Error(`execution ${request.execution_id} resolves its own worktree and inherits one from ${inheritedSessionId}; these are mutually exclusive`);
    }
    const sessionKey = sessionKeyFor(operation_id, this.options.executor_function_identity);
    const response = await this.fetch(`${this.options.base_url}/sessions/resumable/${encodeURIComponent(sessionKey)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        initial_prompt: config.rendered_prompt + publicationInstructions(config),
        workdir: config.workdir,
        name: config.session_name,
        runtime: config.runtime,
        ...(config.model ? { model: config.model } : {}),
        ...(config.effort ? { effort: config.effort } : {}),
        ...(config.artifact_id ? { artifact_id: config.artifact_id } : {}),
        ...(config.worktree ? { worktree: { branch_name: config.worktree.branchName, worktree_subdir: config.worktree.worktreeSubdir,
          ...(config.worktree.baseRef ? { base_ref: selectRemoteWorktreeBase(config.worktree.baseRef) } : {}) } } : {}),
        ...(inheritedSessionId ? { inherit_worktree_from: inheritedSessionId } : {}),
      }),
    });
    if (!response.ok) throw new Error(`kbbl ensure-session failed (${response.status}): ${await response.text()}`);
    const ensured = parseEnsureResponse(await response.json());
    return { kind: "kbbl_session", session_id: ensured.session.sid,
      ...(ensured.session.worktreeBaseRef ? { worktree_base_sha: ensured.session.worktreeBaseRef } : {}) };
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
    if (response.status === 202) {
      // A session that never takes its first turn ends no other way: kbbl keeps
      // answering "not terminal", correctly, and the unit waits on a state that
      // cannot arrive. Bounding the silence is what turns that into a failure
      // an operator can see and rerun, rather than a run that looks alive.
      //
      // Stateless by construction: `lastActivityTs` is an absolute time from
      // kbbl, so nothing has to be carried between polls. That matters because
      // each observation is its own checkpointed step, and a counter held in
      // memory would reset on recovery — the case this is meant to catch.
      const silentFor = silentDurationMs(await response.json().catch(() => null) as JsonValue, (this.options.now ?? Date.now)());
      const limit = this.options.max_silent_ms ?? DEFAULT_MAX_SILENT_MS;
      if (silentFor !== null && silentFor > limit) {
        return terminal({ kind: "failed", code: "executor_silent_timeout",
          detail: `kbbl session ${sessionId} reported no activity for ${Math.round(silentFor / 1000)}s (limit ${Math.round(limit / 1000)}s)` });
      }
      return { kind: "pending" };
    }
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

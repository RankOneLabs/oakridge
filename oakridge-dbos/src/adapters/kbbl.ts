import { ExecutorStartRejectedError, type ExecutionRequest, type ExpectedArtifactContract, type ExecutorAdapter, type ExecutorObservationAttempt, type ExecutorTerminalObservation, type ExecutorUnavailable, type ExternalExecutionReference } from "../domain/execution";
import type { ExecutionId, ExecutorOperationId, JsonValue, } from "../domain/primitives";
import type { InvocationId, ProviderResult } from "../effects/provider";
import type { ResumableEnsureRequest, ResumableEnsureResponse, ResumableInputRequest, ResumableSessionSnapshot, ResumableTerminalFailure } from "../../../kbbl/core/acp/resumable-wire";

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

/**
 * The structured failure kbbl attaches to a terminal body when a session
 * ended badly (`ResumableTerminalFailure`). It is the only place the actual
 * reason survives: the exit code is always 1, so without this a provisioning
 * failure, a killed child, and a failed prompt are indistinguishable to an
 * operator reading the run record. Any non-empty code is kept, so a code a
 * newer kbbl adds still reaches the record.
 */
type KbblTerminalFailure = Omit<ResumableTerminalFailure, "code"> & { readonly code: string };

/** Reads kbbl's `failure` sidecar off a terminal body; null when absent. */
function parseTerminalFailure(raw: unknown): KbblTerminalFailure | null {
  if (typeof raw !== "object" || raw === null || !("failure" in raw)) return null;
  const failure = (raw as { failure: unknown }).failure;
  if (typeof failure !== "object" || failure === null) return null;
  const { code, detail } = failure as { code?: unknown; detail?: unknown };
  if (typeof code !== "string" || code === "") return null;
  return { code, detail: typeof detail === "string" && detail !== "" ? detail : code };
}

interface KbblResolvedSessionIdentity {
  readonly run_id: string;
  readonly stage_instance_id: string;
  readonly unit_id: string;
  readonly cohort_id: string | null;
  readonly operator_role: string | null;
  readonly cohort_title: string | null;
  readonly repository_key: string | null;
}

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
  readonly assessment_unchanged: { readonly assessment: JsonValue; readonly build: JsonValue } | null;
  readonly session_identity: KbblResolvedSessionIdentity;
}

/** The part of a resumable session snapshot the adapter reads. */
type KbblSessionSummary = Readonly<Pick<ResumableSessionSnapshot, "sid" | "status" | "endReason" | "worktreeBaseRef">>;
interface EnsureSessionResponse { readonly kind: ResumableEnsureResponse["kind"]; readonly session: KbblSessionSummary }

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
  const unchanged = isObject(value.assessment_unchanged) && isObject(value.assessment_unchanged.assessment)
    && isObject(value.assessment_unchanged.build)
    ? { assessment: value.assessment_unchanged.assessment, build: value.assessment_unchanged.build } : null;
  const session_identity = parseSessionIdentity(value.session_identity);
  return { runtime, rendered_prompt: renderedPrompt, workdir, session_name: sessionName, model, effort, artifact_id: artifactId, worktree, publication, assessment_unchanged: unchanged, session_identity };
};

/**
 * Every v2 delegated session now carries a `session_identity` (§2 of this
 * cohort) — a resolved config missing it is a hard parse error, not a
 * silently omitted member, since forwarding it is the whole point of this
 * adapter change.
 */
const parseSessionIdentity = (value: JsonValue): KbblResolvedSessionIdentity => {
  if (!isObject(value)) throw new Error("kbbl resolved config is missing session_identity");
  const { run_id, stage_instance_id, unit_id, cohort_id, operator_role, cohort_title, repository_key } = value;
  if (typeof run_id !== "string" || run_id.length === 0
    || typeof stage_instance_id !== "string" || stage_instance_id.length === 0
    || typeof unit_id !== "string" || unit_id.length === 0) {
    throw new Error("kbbl resolved config session_identity is missing required fields");
  }
  return {
    run_id, stage_instance_id, unit_id, cohort_id: typeof cohort_id === "string" ? cohort_id : null,
    operator_role: typeof operator_role === "string" ? operator_role : null,
    cohort_title: typeof cohort_title === "string" ? cohort_title : null,
    repository_key: typeof repository_key === "string" ? repository_key : null,
  };
};

/** The selected worker owns this typed output list; prompt text cannot widen or narrow it. */
export const selectPromptExpectedArtifacts = (_config: Pick<KbblResolvedConfig, "rendered_prompt">,
  request: Pick<ExecutionRequest, "unit_id" | "inputs" | "declared_outputs" | "expected_artifacts">): readonly ExpectedArtifactContract[] => request.expected_artifacts;

const parseEnsureResponse = (value: unknown): EnsureSessionResponse => {
  if (typeof value !== "object" || value === null || !("kind" in value) || !("session" in value)) throw new Error("invalid kbbl ensure-session response");
  const kind = value.kind;
  const session = value.session;
  if ((kind !== "attached" && kind !== "started" && kind !== "terminal") || typeof session !== "object" || session === null || !("sid" in session) || typeof session.sid !== "string" || !("status" in session)) {
    throw new Error("invalid kbbl ensure-session response");
  }
  const status = session.status;
  if (status !== "starting" && status !== "live" && status !== "compacting" && status !== "ended") throw new Error("invalid kbbl session status");
  const endReason = "endReason" in session && (session.endReason === "user_closed" || session.endReason === "subprocess_exited") ? session.endReason : null;
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

export interface PinnedSessionStop { readonly request: PinnedSessionStart; readonly execution_id: ExecutionId; readonly reference: ExternalExecutionReference | null }
export interface PinnedSessionStart { readonly session_key: string; readonly body: string }
export interface SessionStartSelection { readonly request: ExecutionRequest; readonly operation_id: ExecutorOperationId; readonly executor_function_identity: string }

/** Render once at selection. Recovery dispatches the returned body without parsing launch material. */
export function renderSessionStart(input: SessionStartSelection): ProviderResult<PinnedSessionStart> {
  const { request, operation_id, executor_function_identity } = input;
  let config: KbblResolvedConfig;
  try { config = parseResolvedConfig(request.resolved_config); }
  catch (error) { return { kind: "permanently_rejected", code: "start_rejected", detail: error instanceof Error ? error.message : String(error) }; }
  const body: ResumableEnsureRequest = {
        initial_prompt: config.rendered_prompt,
        workdir: config.workdir,
        name: config.session_name,
        runtime: config.runtime,
        ...(config.model ? { model: config.model } : {}),
        ...(config.effort ? { effort: config.effort } : {}),
        ...(config.artifact_id ? { artifact_id: config.artifact_id } : {}),
        ...(config.worktree ? { worktree: { branch_name: config.worktree.branchName, worktree_subdir: config.worktree.worktreeSubdir,
          ...(config.worktree.baseRef ? { base_ref: selectRemoteWorktreeBase(config.worktree.baseRef) } : {}) } } : {}),
        workflow: {
          workflow_run_id: config.session_identity.run_id,
          stage_instance_id: config.session_identity.stage_instance_id,
          unit_id: config.session_identity.unit_id,
          ...(config.session_identity.cohort_id ? { cohort_id: config.session_identity.cohort_id } : {}),
          ...(config.session_identity.operator_role ? { operator_role: config.session_identity.operator_role } : {}),
          ...(config.session_identity.cohort_title ? { cohort_title: config.session_identity.cohort_title } : {}),
          ...(config.session_identity.repository_key ? { repository_key: config.session_identity.repository_key } : {}),
        },
      };
  return { kind: "acknowledged", value: { session_key: sessionKeyFor(operation_id, executor_function_identity), body: JSON.stringify(body) } };
}

export class KbblExecutorAdapter implements ExecutorAdapter {
  readonly executor_type = "delegated_session";
  private readonly fetch: FetchLike;

  constructor(private readonly options: KbblExecutorAdapterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** Typed leaf operation over a pinned request and invocation identity. */
  async start_selected(request: ExecutionRequest, invocation_id: InvocationId): Promise<ProviderResult<ExternalExecutionReference>> {
    try {
      const result = await this.start_or_attach(request, invocation_id as unknown as ExecutorOperationId);
      return result.kind === "executor_unavailable" ? { kind: "uncertain", detail: result.detail }
        : { kind: "acknowledged", value: result };
    } catch (error) {
      if (error instanceof ExecutorStartRejectedError) return { kind: "permanently_rejected", code: "start_rejected", detail: error.message };
      return { kind: "uncertain", detail: String(error) };
    }
  }

  async start_pinned(request: PinnedSessionStart): Promise<ProviderResult<ExternalExecutionReference>> {
    try {
      const result = await this.start_request(request);
      return result.kind === "executor_unavailable" ? { kind: "uncertain", detail: result.detail } : { kind: "acknowledged", value: result };
    } catch (error) {
      return error instanceof ExecutorStartRejectedError ? { kind: "permanently_rejected", code: "start_rejected", detail: error.message }
        : { kind: "uncertain", detail: String(error) };
    }
  }

  async stop_pinned(input: PinnedSessionStop): Promise<ProviderResult<{ readonly stopped: true }>> {
    let reference = input.reference;
    if (!reference) {
      const reconciled = await this.start_pinned(input.request);
      if (reconciled.kind !== "acknowledged") return { kind: "uncertain", detail: reconciled.detail };
      reference = reconciled.value;
    }
    const stopped = await this.cancel_or_fence(input.execution_id, reference);
    return stopped?.kind === "executor_unavailable" ? { kind: "transiently_unavailable", detail: stopped.detail } : { kind: "acknowledged", value: { stopped: true } };
  }

  /** An uncertain start is reconciled by its original identity before stop. */
  async stop_selected(request: ExecutionRequest, invocation_id: InvocationId, reference: ExternalExecutionReference | null): Promise<ProviderResult<{ readonly stopped: true }>> {
    let known = reference;
    if (!known) {
      const reconciled = await this.start_selected(request, invocation_id);
      if (reconciled.kind === "permanently_rejected") return { kind: "uncertain", detail: `cannot prove cleanup: ${reconciled.code}: ${reconciled.detail}` };
      if (reconciled.kind !== "acknowledged") return { kind: "uncertain", detail: reconciled.detail };
      known = reconciled.value;
    }
    const stopped = await this.cancel_or_fence(request.execution_id, known);
    return stopped?.kind === "executor_unavailable" ? { kind: "transiently_unavailable", detail: stopped.detail }
      : { kind: "acknowledged", value: { stopped: true } };
  }

  async start_or_attach(request: ExecutionRequest, operation_id: ExecutorOperationId): Promise<ExternalExecutionReference | ExecutorUnavailable> {
    const rendered = renderSessionStart({ request, operation_id, executor_function_identity: this.options.executor_function_identity });
    if (rendered.kind !== "acknowledged") throw new ExecutorStartRejectedError(rendered.detail);
    return this.start_request(rendered.value);
  }

  async ensure_collaboration(request: PinnedSessionStart): Promise<ProviderResult<ExternalExecutionReference>> {
    try {
      const result = await this.start_request(request, true);
      return result.kind === "executor_unavailable" ? { kind: "uncertain", detail: result.detail }
        : { kind: "acknowledged", value: result };
    } catch (error) {
      return { kind: "permanently_rejected", code: "ensure_failed", detail: String(error) };
    }
  }

  private async start_request(request: PinnedSessionStart, collaboration_resume = false): Promise<ExternalExecutionReference | ExecutorUnavailable> {
    let response: Response;
    try { response = await this.fetch(`${this.options.base_url}/sessions/resumable/${encodeURIComponent(request.session_key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(collaboration_resume ? { "x-oakridge-collaboration-resume": "true" } : {}) },
      body: request.body,
    }); } catch (error) { return { kind: "executor_unavailable", operation: "start_or_attach", detail: String(error) }; }
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) throw new ExecutorStartRejectedError(`kbbl ensure-session failed (${response.status}): ${await response.text()}`);
      return { kind: "executor_unavailable", operation: "start_or_attach", detail: `kbbl ensure-session failed (${response.status})` };
    }
    const ensured = parseEnsureResponse(await response.json());
    return { kind: "kbbl_session", session_id: ensured.session.sid,
      ...(ensured.session.worktreeBaseRef ? { worktree_base_sha: ensured.session.worktreeBaseRef } : {}) };
  }

  async observe_terminal(execution_id: ExecutionId, external_reference: ExternalExecutionReference): Promise<ExecutorObservationAttempt | ExecutorUnavailable> {
    // Reported as a failure rather than thrown, unlike `cancel_or_fence` below.
    // This is the only path by which a unit can ever be reported terminal, and
    // it runs inside a retrying step: throwing exhausts the retries, kills the
    // terminal observer, and leaves the execution waiting on a message that can
    // now never arrive — a silent stall an operator has to go hunting for.
    // A named failure code parks the unit for rerun and says what happened.
    if (external_reference.kind !== "kbbl_session") return terminal({ kind: "failed", code: "session_not_ensured", detail: `no kbbl session is associated with execution ${execution_id}` });
    const sessionId = external_reference.session_id;
    const url = `${this.options.base_url}/sessions/resumable/${encodeURIComponent(sessionId)}/terminal?wait_ms=${this.options.observe_wait_ms ?? DEFAULT_OBSERVE_WAIT_MS}`;
    let response: Response;
    try { response = await this.fetch(url); }
    catch (error) { return { kind: "executor_unavailable", operation: "observe_terminal", detail: String(error) }; }
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
    if (!response.ok) return { kind: "executor_unavailable", operation: "observe_terminal", detail: `kbbl terminal observation failed (${response.status})` };
    const raw = await response.json();
    if (typeof raw !== "object" || raw === null || !("session" in raw) || typeof raw.session !== "object" || raw.session === null || !("endReason" in raw.session)) {
      return terminal({ kind: "failed", code: "invalid_terminal_response", detail: "kbbl returned an invalid terminal response" });
    }
    if (raw.session.endReason === "user_closed") {
      const cancelled = { kind: "cancelled" as const, code: "executor_cancelled", detail: "kbbl session was closed" };
      return terminal(cancelled);
    }
    const exitCode = "exit_code" in raw && typeof raw.exit_code === "number" ? raw.exit_code : null;
    // Success must be positively established. A session whose exit code kbbl
    // cannot report — it crashed before writing one, or predates exit-code
    // reconstruction — is reported as failed, not assumed clean: treating an
    // unknown code as success strands the execution waiting for artifacts a
    // dead runtime will never emit, with nothing visible to the operator.
    if (exitCode === null) return terminal({ kind: "failed", code: "exit_unknown", detail: `kbbl session ${sessionId} ended without a recorded exit code` });
    if (exitCode !== 0) {
      // Every kbbl failure exits 1, so the exit code says nothing an operator
      // can act on. When kbbl names the failure, that name is the observation:
      // "requested_model_unsupported" is a config fix, "kbbl_restart" is a
      // rerun. `executor_exit_nonzero` stays the honest answer only when kbbl
      // sends no structured failure at all.
      const failure = parseTerminalFailure(raw);
      if (failure) return terminal({ kind: "failed", code: failure.code, detail: `kbbl session ${sessionId} failed: ${failure.detail}` });
      return terminal({ kind: "failed", code: "executor_exit_nonzero", detail: `kbbl runtime exited with code ${exitCode}` });
    }
    return terminal({ kind: "succeeded", metadata: { session_id: sessionId, exit_code: exitCode } });
  }

  async cancel_or_fence(execution_id: ExecutionId, external_reference: ExternalExecutionReference): Promise<void | ExecutorUnavailable> {
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
    let response: Response;
    try { response = await this.fetch(url, { method: "DELETE" }); }
    catch (error) { return { kind: "executor_unavailable", operation: "cancel_or_fence", detail: String(error) }; }
    if (!response.ok && response.status !== 404) return { kind: "executor_unavailable", operation: "cancel_or_fence", detail: `kbbl cancellation failed (${response.status})` };
  }

  async deliver_input(execution_id: ExecutionId, delivery_key: string, input: string, external_reference: ExternalExecutionReference): Promise<void> {
    const result = await this.deliver_collaboration_input(execution_id,delivery_key,input,external_reference);
    if (result.kind !== "acknowledged") throw new Error(result.detail);
  }

  /** Keyed input uses kbbl's durable dedup; classify refusal separately from uncertain transport. */
  async deliver_collaboration_input(execution_id: ExecutionId, delivery_key: string, input: string,
    external_reference: ExternalExecutionReference): Promise<ProviderResult<void>> {
    const sessionId = sessionIdOf(external_reference, execution_id);
    try {
      const response = await this.fetch(`${this.options.base_url}/sessions/resumable/${encodeURIComponent(sessionId)}/input/${encodeURIComponent(delivery_key)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: input } satisfies ResumableInputRequest),
      });
      if (response.ok) return { kind: "acknowledged", value: undefined };
      const detail = `kbbl input delivery failed (${response.status}): ${await response.text()}`;
      return response.status >= 500 || response.status === 408 || response.status === 429 ? { kind: "uncertain", detail }
        : { kind: "permanently_rejected", code: "input_refused", detail };
    } catch (error) { return { kind: "uncertain", detail: `kbbl input delivery uncertain: ${String(error)}` }; }
  }
}

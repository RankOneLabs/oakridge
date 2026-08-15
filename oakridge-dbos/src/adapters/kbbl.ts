import type { ExecutionRequest, ExecutorAdapter, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import type { ExecutionId, JsonValue } from "../domain/primitives";

interface KbblResolvedConfig {
  readonly runtime: "claude-code" | "codex";
  readonly rendered_prompt: string;
  readonly workdir: string;
  readonly session_name: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly artifact_id: string | null;
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
  return { runtime, rendered_prompt: renderedPrompt, workdir, session_name: sessionName, model, effort, artifact_id: artifactId };
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
  readonly fetch?: FetchLike;
}

export class KbblExecutorAdapter implements ExecutorAdapter {
  readonly executor_type = "delegated_session";
  private readonly fetch: FetchLike;
  private readonly sessionsByExecution = new Map<ExecutionId, string>();

  constructor(private readonly options: KbblExecutorAdapterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async start_or_attach(request: ExecutionRequest): Promise<ExternalExecutionReference> {
    const config = parseResolvedConfig(request.resolved_config);
    const sessionKey = `${request.execution_id}:${this.options.executor_function_identity}`;
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
      }),
    });
    if (!response.ok) throw new Error(`kbbl ensure-session failed (${response.status}): ${await response.text()}`);
    const ensured = parseEnsureResponse(await response.json());
    this.sessionsByExecution.set(request.execution_id, ensured.session.sid);
    return { kind: "kbbl_session", session_id: ensured.session.sid };
  }

  async observe_terminal(execution_id: ExecutionId, external_reference?: ExternalExecutionReference): Promise<ExecutorTerminalObservation> {
    const sessionId = external_reference?.kind === "kbbl_session" ? external_reference.session_id : this.sessionsByExecution.get(execution_id);
    if (!sessionId) return { kind: "failed", code: "session_not_ensured", detail: `no kbbl session is associated with execution ${execution_id}` };
    const response = await this.fetch(`${this.options.base_url}/sessions/resumable/${encodeURIComponent(sessionId)}/terminal`);
    if (!response.ok) return { kind: "failed", code: "terminal_observation_failed", detail: `kbbl terminal observation failed (${response.status}): ${await response.text()}` };
    const raw = await response.json();
    if (typeof raw !== "object" || raw === null || !("session" in raw) || typeof raw.session !== "object" || raw.session === null || !("endReason" in raw.session)) {
      return { kind: "failed", code: "invalid_terminal_response", detail: "kbbl returned an invalid terminal response" };
    }
    if (raw.session.endReason === "user_closed") return { kind: "cancelled", detail: "kbbl session was closed" };
    const exitCode = "exit_code" in raw && typeof raw.exit_code === "number" ? raw.exit_code : null;
    if (exitCode !== null && exitCode !== 0) return { kind: "failed", code: "executor_exit_nonzero", detail: `kbbl runtime exited with code ${exitCode}` };
    return { kind: "succeeded", metadata: { session_id: sessionId, exit_code: exitCode } };
  }

  async cancel_or_fence(execution_id: ExecutionId, external_reference?: ExternalExecutionReference): Promise<void> {
    const sessionId = external_reference?.kind === "kbbl_session" ? external_reference.session_id : this.sessionsByExecution.get(execution_id);
    if (!sessionId) return;
    const response = await this.fetch(`${this.options.base_url}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`kbbl cancellation failed (${response.status}): ${await response.text()}`);
  }

  async deliver_input(execution_id: ExecutionId, delivery_key: string, input: string, external_reference?: ExternalExecutionReference): Promise<void> {
    const sessionId = external_reference?.kind === "kbbl_session" ? external_reference.session_id : this.sessionsByExecution.get(execution_id);
    if (!sessionId) throw new Error(`no kbbl session is associated with execution ${execution_id}`);
    const response = await this.fetch(`${this.options.base_url}/sessions/resumable/${encodeURIComponent(sessionId)}/input/${encodeURIComponent(delivery_key)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: input }),
    });
    if (!response.ok) throw new Error(`kbbl revision delivery failed (${response.status}): ${await response.text()}`);
  }
}

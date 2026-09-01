// One controller == one kbbl session == at most one ACP child process
// (§8.4). Owns: spawn+initialize+new/load, the live prompt mutex, turn
// outcome recording, accepted-turn dispatch, pending permissions, UI
// event projection, cancel, and the fence sequence. It owns NO workflow
// policy and NO provider-specific branches.

import type * as schema from "@agentclientprotocol/sdk";

import type { AgentProfile } from "./agent-profile";
import { AcpClient } from "./client";
import {
  projectConfigOptions,
  projectPermissionRequest,
  projectSessionUpdate,
} from "./event-projector";
import type { AcpChildProcess, AcpProcessSupervisor } from "./process-supervisor";
import { AcpSessionStore } from "./store";
import {
  acpError,
  err,
  ok,
  type AcpAgentSessionId,
  type AcpError,
  type AcpTurnRow,
  type AcpUiEvent,
  type KbblSessionId,
  type Result,
  type StopReason,
} from "./types";

export interface ControllerConfig {
  readonly live_event_buffer: number;
  /** Bounded wait for a session/close answer before killing the child. */
  readonly close_grace_ms: number;
}

export interface ControllerDeps {
  readonly sid: KbblSessionId;
  readonly profile: AgentProfile;
  readonly store: AcpSessionStore;
  readonly supervisor: AcpProcessSupervisor;
  readonly config: ControllerConfig;
  /** Called when the child dies so the registry can drop this controller. */
  readonly onDefunct: (sid: KbblSessionId) => void;
}

export type ControllerStartMode =
  | { kind: "new" }
  | { kind: "load"; acp_session_id: AcpAgentSessionId };

interface PendingPermission {
  readonly requestId: string;
  resolve(response: schema.RequestPermissionResponse): void;
}

export type UiEventListener = (event: AcpUiEvent) => void;

/**
 * Pure resolver for requested model/effort against the agent's config
 * options (§12): first select option in the semantic category, matched by
 * value id or normalized display name. Returns null when nothing was
 * requested; an error when a request cannot be satisfied.
 */
export function resolveRequestedOption(
  options: readonly schema.SessionConfigOption[],
  category: "model" | "thought_level",
  requested: string | null,
): Result<{ configId: string; valueId: string } | null, AcpError> {
  if (requested === null) return ok(null);
  const code =
    category === "model"
      ? ("requested_model_unsupported" as const)
      : ("requested_effort_unsupported" as const);
  const selector = options.find(
    (option) => option.type === "select" && option.category === category,
  );
  if (!selector || selector.type !== "select") {
    return err(
      acpError(
        code,
        "resolveRequestedOption",
        `agent exposes no select config option with category "${category}"`,
      ),
    );
  }
  const normalized = requested.trim().toLowerCase();
  const flat = selector.options.flatMap((entry) =>
    "options" in entry ? entry.options : [entry],
  );
  const match = flat.find(
    (item) =>
      item.value === requested ||
      item.value.toLowerCase() === normalized ||
      item.name.trim().toLowerCase() === normalized,
  );
  if (!match) {
    return err(
      acpError(
        code,
        "resolveRequestedOption",
        `no option matching "${requested}" in config option "${selector.id}"`,
      ),
    );
  }
  return ok({ configId: selector.id, valueId: match.value });
}

export class AcpSessionController {
  private child: AcpChildProcess | null = null;
  private client: AcpClient | null = null;
  private acpSessionId: AcpAgentSessionId | null = null;
  private configOptions: readonly schema.SessionConfigOption[] = [];
  private activeTurnKey: string | null = null;
  private replaying = false;
  private fenced = false;
  private defunct = false;
  private permissionCounter = 0;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly events: AcpUiEvent[] = [];
  private readonly listeners = new Set<UiEventListener>();

  constructor(private readonly deps: ControllerDeps) {}

  get sid(): KbblSessionId {
    return this.deps.sid;
  }

  get sessionId(): AcpAgentSessionId | null {
    return this.acpSessionId;
  }

  get isPromptActive(): boolean {
    return this.activeTurnKey !== null;
  }

  get isDefunct(): boolean {
    return this.defunct;
  }

  get liveConfigOptions(): readonly schema.SessionConfigOption[] {
    return this.configOptions;
  }

  get childPid(): number | null {
    return this.child?.pid ?? null;
  }

  get hasSubscribers(): boolean {
    return this.listeners.size > 0;
  }

  snapshotEvents(): readonly AcpUiEvent[] {
    return [...this.events];
  }

  subscribe(listener: UiEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Spawns the child, initializes ACP v1, validates capabilities, and
   * creates or loads the agent session (§10.2 steps 5–10 / §10.3).
   */
  async start(
    cwd: string,
    mode: ControllerStartMode,
  ): Promise<Result<void, AcpError>> {
    const spawned = this.deps.supervisor.spawn(this.deps.profile, cwd);
    if (!spawned.ok) return spawned;
    this.child = spawned.value;
    this.child.onExit((code) => this.handleChildExit(code));

    this.client = new AcpClient(this.deps.sid, this.child, {
      onSessionUpdate: (notification) => this.handleUpdate(notification),
      onPermissionRequest: (request) => this.handlePermissionRequest(request),
    });

    const initialized = await this.client.initialize();
    if (!initialized.ok) {
      await this.teardownChild();
      return initialized;
    }
    if (
      this.deps.profile.requireLoadSession &&
      this.client.agentCapabilities.loadSession !== true
    ) {
      await this.teardownChild();
      return err(
        acpError(
          "acp_required_capability_missing",
          "controller.start",
          `profile "${this.deps.profile.id}" requires session/load but the agent does not advertise loadSession`,
          this.deps.sid,
        ),
      );
    }

    if (mode.kind === "new") {
      const created = await this.client.newSession(cwd);
      if (!created.ok) {
        await this.teardownChild();
        return created;
      }
      this.acpSessionId = created.value.sessionId as AcpAgentSessionId;
      this.configOptions = created.value.configOptions ?? [];
      this.deps.store.setAcpSessionId(this.deps.sid, this.acpSessionId);
      if (this.configOptions.length > 0) {
        this.emit(projectConfigOptions(this.configOptions));
      }
      return ok(undefined);
    }

    this.acpSessionId = mode.acp_session_id;
    this.replaying = true;
    const loaded = await this.client.loadSession(mode.acp_session_id, cwd);
    this.replaying = false;
    if (!loaded.ok) {
      await this.teardownChild();
      return loaded;
    }
    return ok(undefined);
  }

  /** §12: apply requested model/effort via semantic config categories. */
  async applyRequestedConfig(
    requestedModel: string | null,
    requestedEffort: string | null,
  ): Promise<Result<void, AcpError>> {
    const requests: Array<["model" | "thought_level", string | null]> = [
      ["model", requestedModel],
      ["thought_level", requestedEffort],
    ];
    for (const [category, requested] of requests) {
      const resolved = resolveRequestedOption(
        this.configOptions,
        category,
        requested,
      );
      if (!resolved.ok) return resolved;
      if (resolved.value === null) continue;
      const client = this.client;
      if (!client) {
        return err(this.notLiveError("controller.applyRequestedConfig"));
      }
      const applied = await client.setConfigOption(
        String(this.acpSessionId),
        resolved.value.configId,
        resolved.value.valueId,
      );
      if (!applied.ok) return applied;
    }
    return ok(undefined);
  }

  async setConfigOption(
    configId: string,
    value: string | boolean,
  ): Promise<Result<void, AcpError>> {
    const client = this.client;
    if (!client || this.acpSessionId === null) {
      return err(this.notLiveError("controller.setConfigOption"));
    }
    const applied = await client.setConfigOption(
      this.acpSessionId,
      configId,
      value,
    );
    if (!applied.ok) return applied;
    return ok(undefined);
  }

  /**
   * Runs one prompt turn to completion. The caller must have inserted the
   * turn row; this flips it to `prompting` BEFORE sending (§10.7), then
   * records the outcome from the prompt response — the only success
   * signal (§18). Exactly one prompt may be active (guardrail 8).
   */
  async runTurn(turn: AcpTurnRow): Promise<Result<void, AcpError>> {
    if (this.fenced) {
      return err(
        acpError(
          "session_fenced",
          "controller.runTurn",
          "session is fenced",
          this.deps.sid,
        ),
      );
    }
    if (this.activeTurnKey !== null) {
      return err(
        acpError(
          "session_busy",
          "controller.runTurn",
          `turn ${this.activeTurnKey} is active`,
          this.deps.sid,
        ),
      );
    }
    const client = this.client;
    if (!client || this.acpSessionId === null) {
      return err(this.notLiveError("controller.runTurn"));
    }

    this.activeTurnKey = turn.turn_key;
    this.deps.store.markTurnPrompting(turn.sid, turn.turn_key);
    this.deps.store.setStatus(turn.sid, "prompting");
    this.deps.store.touchActivity(turn.sid);
    this.emit({ kind: "turn_state", state: "prompting" });
    console.log(
      `[acp] sid=${turn.sid} turn=${turn.turn_key} prompting (pid=${this.childPid})`,
    );

    const response = await client.prompt(this.acpSessionId, turn.payload);
    // The exit handler may have already classified this turn as lost.
    if (this.activeTurnKey !== turn.turn_key) {
      return err(
        acpError(
          "acp_transport_lost",
          "controller.runTurn",
          "agent process/transport was lost during the prompt",
          this.deps.sid,
        ),
      );
    }
    this.activeTurnKey = null;

    if (!response.ok) {
      // §10.4: transport loss (child exit, closed stream) means the answer
      // never arrived — the outcome is uncertain, never a plain failure.
      const lost =
        this.defunct || response.error.code === "acp_transport_lost";
      const code = lost ? ("acp_transport_lost" as const) : response.error.code;
      this.deps.store.completeTurn(turn.sid, turn.turn_key, {
        status: lost ? "unknown" : "failed",
        failure_code: code,
        failure_detail: response.error.detail,
      });
      this.finishTurn(
        turn,
        lost ? "unknown" : "failed",
        undefined,
        response.error.detail,
      );
      return err({ ...response.error, code });
    }

    const stopReason: StopReason = response.value.stopReason;
    if (stopReason === "end_turn") {
      this.deps.store.completeTurn(turn.sid, turn.turn_key, {
        status: "succeeded",
        stop_reason: stopReason,
      });
      this.finishTurn(turn, "idle", stopReason);
      return ok(undefined);
    }
    if (stopReason === "cancelled") {
      this.deps.store.completeTurn(turn.sid, turn.turn_key, {
        status: "cancelled",
        stop_reason: stopReason,
      });
      this.finishTurn(turn, "cancelled", stopReason);
      return ok(undefined);
    }
    // Any other stop reason is failure unless deliberately allowlisted
    // (§18) — there is no allowlist yet.
    this.deps.store.completeTurn(turn.sid, turn.turn_key, {
      status: "failed",
      stop_reason: stopReason,
      failure_code: "acp_prompt_failed",
      failure_detail: `stop reason "${stopReason}"`,
    });
    this.finishTurn(turn, "failed", stopReason);
    return err(
      acpError(
        "acp_prompt_failed",
        "controller.runTurn",
        `prompt stopped with "${stopReason}"`,
        this.deps.sid,
      ),
    );
  }

  /**
   * §11.3: dispatches retained `accepted` turns serially, oldest first,
   * until none remain or one fails to reach the agent.
   */
  async dispatchAcceptedTurns(): Promise<void> {
    while (!this.fenced && !this.defunct && this.activeTurnKey === null) {
      const next = this.deps.store.listAcceptedTurns(this.deps.sid)[0];
      if (!next) return;
      const result = await this.runTurn(next);
      // A turn that reached the agent and failed is completed; move on to
      // the next accepted turn. A turn that could not be dispatched at
      // all (busy/fenced/transport) leaves the ledger as-is for a later
      // touch — bail rather than spin.
      if (
        !result.ok &&
        (result.error.code === "session_busy" ||
          result.error.code === "session_fenced" ||
          result.error.code === "acp_transport_lost")
      ) {
        return;
      }
    }
  }

  /** Normal user stop: forwards session/cancel; outcome arrives via the
   * active prompt's response (stopReason "cancelled"). Not a fence. */
  async cancelActiveTurn(): Promise<Result<void, AcpError>> {
    const client = this.client;
    if (!client || this.acpSessionId === null) {
      return err(this.notLiveError("controller.cancelActiveTurn"));
    }
    return client.cancel(this.acpSessionId);
  }

  /**
   * §10.5 fence sequence: record fencer, reject new input, cancel any
   * active prompt, session/close when advertised, bounded terminate,
   * SIGKILL fallback. Idempotent.
   */
  async fence(fencedBy: string, endReason = "fenced"): Promise<void> {
    if (this.fenced) return;
    this.fenced = true;
    this.deps.store.setFencedBy(this.deps.sid, fencedBy);
    this.rejectPendingPermissions();

    const client = this.client;
    if (client && this.acpSessionId !== null) {
      if (this.activeTurnKey !== null) {
        await client.cancel(this.acpSessionId);
      }
      await this.closeSessionBounded(client);
    }
    await this.teardownChild();
    this.deps.store.markEnded(this.deps.sid, "fenced", endReason, fencedBy);
    console.log(`[acp] sid=${this.deps.sid} fenced by ${fencedBy}`);
    this.deps.onDefunct(this.deps.sid);
  }

  /** Idle-child close (§10.8) and shutdown path: no fence semantics. */
  async closeChild(): Promise<void> {
    if (this.defunct) return;
    const client = this.client;
    if (client && this.acpSessionId !== null) {
      await this.closeSessionBounded(client);
    }
    await this.teardownChild();
    this.deps.onDefunct(this.deps.sid);
  }

  /** §10.5 steps 4–5: session/close when advertised, bounded grace — an
   * agent that ignores close must not stall the kill (guardrail 19). */
  private async closeSessionBounded(client: AcpClient): Promise<void> {
    if (!client.agentCapabilities.sessionCapabilities?.close) return;
    if (this.acpSessionId === null) return;
    await Promise.race([
      client.closeSession(this.acpSessionId),
      new Promise((resolve) =>
        setTimeout(resolve, this.deps.config.close_grace_ms),
      ),
    ]);
  }

  resolvePermission(
    requestId: string,
    optionId: string,
  ): Result<void, AcpError> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      return err(
        acpError(
          "acp_prompt_failed",
          "controller.resolvePermission",
          `no pending permission request "${requestId}"`,
          this.deps.sid,
        ),
      );
    }
    this.pendingPermissions.delete(requestId);
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    return ok(undefined);
  }

  stderrTail(): readonly string[] {
    return this.child?.stderrTail() ?? [];
  }

  // === internals ===

  private emit(event: AcpUiEvent): void {
    this.events.push(event);
    const overflow = this.events.length - this.deps.config.live_event_buffer;
    if (overflow > 0) this.events.splice(0, overflow);
    for (const listener of this.listeners) listener(event);
  }

  private handleUpdate(notification: schema.SessionNotification): void {
    this.deps.store.touchActivity(this.deps.sid);
    const projected = projectSessionUpdate(notification.update, this.replaying);
    if (projected === null) {
      console.log(
        `[acp] sid=${this.deps.sid} unprojected update "${notification.update.sessionUpdate}"`,
      );
      return;
    }
    if (projected.kind === "config_options") {
      // Keep the controller's cache authoritative for the §12 resolver.
      const update = notification.update;
      if (update.sessionUpdate === "config_option_update") {
        this.configOptions = update.configOptions;
      }
    }
    this.emit(projected);
  }

  private handlePermissionRequest(
    request: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    this.permissionCounter += 1;
    const requestId = `perm-${this.permissionCounter}`;
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { requestId, resolve });
      this.emit(projectPermissionRequest(requestId, request));
      console.log(
        `[acp] sid=${this.deps.sid} permission requested (${requestId}: ${request.toolCall.title ?? "untitled"})`,
      );
    });
  }

  private rejectPendingPermissions(): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
  }

  /**
   * §10.4: transport loss during an active prompt is an uncertain
   * outcome — never success. Process loss also fails pending permissions
   * and retires this controller.
   */
  private handleChildExit(code: number): void {
    if (this.defunct) return;
    this.defunct = true;
    this.rejectPendingPermissions();
    if (this.activeTurnKey !== null) {
      const turnKey = this.activeTurnKey;
      this.activeTurnKey = null;
      this.deps.store.completeTurn(
        this.deps.sid,
        turnKey as AcpTurnRow["turn_key"],
        {
          status: "unknown",
          failure_code: "acp_transport_lost",
          failure_detail: `agent process exited (code ${code}) during an active prompt`,
        },
      );
      this.deps.store.setStatus(this.deps.sid, "idle");
      this.emit({
        kind: "turn_state",
        state: "unknown",
        detail: `agent process exited (code ${code}) during the turn`,
      });
      console.error(
        `[acp] sid=${this.deps.sid} child exited code=${code} during turn ${turnKey}; outcome unknown`,
      );
    }
    this.client?.close();
    this.deps.onDefunct(this.deps.sid);
  }

  private finishTurn(
    turn: AcpTurnRow,
    state: "idle" | "cancelled" | "failed" | "unknown",
    stopReason?: string,
    detail?: string,
  ): void {
    if (!this.defunct) this.deps.store.setStatus(turn.sid, "idle");
    this.deps.store.touchActivity(turn.sid);
    this.emit({ kind: "turn_state", state, stopReason, detail });
    console.log(
      `[acp] sid=${turn.sid} turn=${turn.turn_key} finished state=${state} stop=${stopReason ?? "-"}`,
    );
  }

  private async teardownChild(): Promise<void> {
    this.defunct = true;
    this.client?.close();
    this.client = null;
    if (this.child) {
      await this.child.kill();
      this.child = null;
    }
  }

  private notLiveError(operation: string): AcpError {
    return acpError(
      "acp_transport_lost",
      operation,
      "no live ACP connection for this controller",
      this.deps.sid,
    );
  }
}

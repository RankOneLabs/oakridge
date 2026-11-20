import { createTranscriptBuffer, foldUpdate } from "./transcript-fold";
import { streamEpoch, type StreamEpoch, type TranscriptBuffer, type TranscriptEmission, type TranscriptSnapshot } from "./transcript-model";
import { AcpControllerProcess } from "#kbbl/core/acp/controller-process";
// One controller == one kbbl session == at most one ACP child process
// (§8.4). Owns: spawn+initialize+new/load, the live prompt mutex, turn
// outcome recording, accepted-turn dispatch, pending permissions, UI
// event projection, cancel, and the fence sequence. It owns NO workflow
// policy and NO provider-specific branches.

import type * as schema from "@agentclientprotocol/sdk";

import type { AgentProfile } from "./agent-profile";
import {
  projectPermissionRequest,
  projectSessionUpdate,
} from "./event-projector";
import type { AcpProcessSupervisor } from "./process-supervisor";
import { AcpSessionStore } from "./store";
import {
  acpError,
  err,
  ok,
  type AcpAgentSessionId,
  type AcpError,
  type AcpSessionRow,
  type AcpTurnRow,
  type AcpUiEvent,
  type KbblSessionId,
  type Result,
  type TurnKey,
} from "./types";

export interface ControllerConfig {
  readonly live_item_buffer: number;
  /** Bounded wait for a session/close answer before killing the child. */
  readonly close_grace_ms: number;
}

export interface ControllerDeps {
  readonly prepareIntegration?: () => Result<import("./session-integration").SessionIntegrationLaunch, AcpError>;
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

export type UiEventListener = (emission: TranscriptEmission) => void;

/** The durable §12 requests a session row carries across every spawn. */
export type RequestedSessionConfig = Pick<
  AcpSessionRow,
  "requested_model" | "requested_effort" | "requested_mode"
>;

export class AcpSessionController {
  /** §14.4: SSE event ids only have meaning within one projection epoch. */
  readonly streamEpoch: StreamEpoch = streamEpoch(crypto.randomUUID());
  private activeTurnKey: TurnKey | null = null;
  private fenced = false;
  private permissionCounter = 0;
  private chunkCounter = 0;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private transcript: TranscriptBuffer;
  private readonly listeners = new Set<UiEventListener>();

  private readonly process: AcpControllerProcess;
  constructor(private readonly deps: ControllerDeps) {
    this.transcript = createTranscriptBuffer({ epoch: this.streamEpoch, capacity: deps.config.live_item_buffer });
    this.process = new AcpControllerProcess(deps, {
      emit: event => this.emit(event),
      update: notification => this.handleUpdate(notification),
      permission: request => this.handlePermissionRequest(request),
      exit: code => this.handleChildExit(code),
    });
  }
  start(...args: Parameters<AcpControllerProcess["start"]>) { return this.process.start(...args); }
  applyRequestedConfig(requested: RequestedSessionConfig) { return this.process.applyRequestedConfig(requested); }
  setConfigOption(configId: string, value: string | boolean) { return this.process.setConfigOption(configId, value); }

  get sid(): KbblSessionId {
    return this.deps.sid;
  }

  get sessionId(): AcpAgentSessionId | null {
    return this.process.acpSessionId;
  }

  get isPromptActive(): boolean {
    return this.activeTurnKey !== null;
  }

  get isDefunct(): boolean {
    return this.process.defunct;
  }

  get liveConfigOptions(): readonly schema.SessionConfigOption[] {
    return this.process.configOptions;
  }

  get childPid(): number | null {
    return this.process.child?.pid ?? null;
  }

  get hasSubscribers(): boolean {
    return this.listeners.size > 0;
  }

  snapshotTranscript(): TranscriptSnapshot {
    const { epoch, items, is_truncated, live_state } = this.transcript;
    return { stream_epoch: epoch, items, is_truncated, live_state };
  }

  subscribe(listener: UiEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    const client = this.process.client;
    if (!client || this.process.acpSessionId === null) {
      return err(this.process.notLiveError("controller.runTurn"));
    }

    this.activeTurnKey = turn.turn_key;
    this.deps.store.markTurnPrompting(turn.sid, turn.turn_key);
    this.deps.store.setStatus(turn.sid, "prompting");
    this.deps.store.touchActivity(turn.sid);
    // Agents do not echo the prompt back as a user_message_chunk (that
    // update type is for replay and agent-injected user turns), so the
    // dispatched text is projected here — the only place every turn
    // source (initial, operator, collaboration) passes through.
    this.emit({
      kind: "user_message",
      id: turn.turn_key,
      messageId: null,
      turnKey: turn.turn_key,
      content: [{ type: "text", text: turn.payload }],
      replayed: false,
    });
    this.emit({ kind: "turn_state", turnKey: turn.turn_key, state: "prompting" });
    console.log(
      `[acp] sid=${turn.sid} turn=${turn.turn_key} prompting (pid=${this.childPid})`,
    );

    const response = await client.prompt(this.process.acpSessionId, turn.payload);
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
        this.process.defunct || response.error.code === "acp_transport_lost";
      const code = lost ? ("acp_transport_lost" as const) : response.error.code;
      this.deps.store.completeTurn(turn.sid, turn.turn_key, {
        status: lost ? "unknown" : "failed",
        failure_code: code,
        failure_detail: response.error.detail,
      }, { status: "absent" });
      this.finishTurn(
        turn,
        lost ? "unknown" : "failed",
        undefined,
        response.error.detail,
      );
      return err({ ...response.error, code });
    }

    const usage = this.process.usage.turn(response.value);
    const stopReason: schema.StopReason = response.value.stopReason;
    if (stopReason === "end_turn") {
      this.deps.store.completeTurn(turn.sid, turn.turn_key, {
        status: "succeeded",
        stop_reason: stopReason,
      }, usage);
      this.finishTurn(turn, "idle", stopReason);
      return ok(undefined);
    }
    if (stopReason === "cancelled") {
      this.deps.store.completeTurn(turn.sid, turn.turn_key, {
        status: "cancelled",
        stop_reason: stopReason,
      }, usage);
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
    }, usage);
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
    while (!this.fenced && !this.process.defunct && this.activeTurnKey === null) {
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
    const client = this.process.client;
    if (!client || this.process.acpSessionId === null) {
      return err(this.process.notLiveError("controller.cancelActiveTurn"));
    }
    return client.cancel(this.process.acpSessionId);
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

    const client = this.process.client;
    if (client && this.process.acpSessionId !== null) {
      if (this.activeTurnKey !== null) {
        await client.cancel(this.process.acpSessionId);
      }
      await this.process.closeSessionBounded(client);
    }
    await this.process.teardownChild();
    this.deps.store.markEnded(this.deps.sid, {
      status: "fenced",
      reason: endReason,
      fenced_by: fencedBy,
    });
    console.log(`[acp] sid=${this.deps.sid} fenced by ${fencedBy}`);
    this.deps.onDefunct(this.deps.sid);
  }

  /** Idle-child close (§10.8) and shutdown path: no fence semantics. */
  async closeChild(): Promise<void> {
    if (this.process.defunct) return;
    const client = this.process.client;
    if (client && this.process.acpSessionId !== null) {
      await this.process.closeSessionBounded(client);
    }
    await this.process.teardownChild();
    this.deps.onDefunct(this.deps.sid);
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
    this.deps.store.touchActivity(this.deps.sid);
    this.emit({
      kind: "permission_resolved",
      requestId,
      outcome: "selected",
      optionId,
    });
    return ok(undefined);
  }

  get pendingPermissionCount(): number {
    return this.pendingPermissions.size;
  }

  stderrTail(): readonly string[] {
    return this.process.child?.stderrTail() ?? [];
  }

  // === internals ===

  private emit(event: AcpUiEvent): void {
    const folded = foldUpdate(this.transcript, event);
    this.transcript = folded.buffer;
    const emission: TranscriptEmission = { event, frames: folded.frames };
    for (const listener of this.listeners) listener(emission);
  }

  private handleUpdate(notification: schema.SessionNotification): void {
    // session/load replays historical chunks through the same notification
    // callback. A history read is not live activity and must not rewrite the
    // session timestamp or fan out one global inbox update per replay chunk.
    if (!this.process.replaying) this.deps.store.touchActivity(this.deps.sid);
    // While a kbbl-dispatched prompt is active, a live user_message_chunk
    // is the agent echoing that prompt back — runTurn already projected
    // the dispatched text, so the echo would duplicate it. Replayed user
    // chunks (session/load) still flow: there runTurn emitted nothing.
    if (
      !this.process.replaying &&
      this.activeTurnKey !== null &&
      notification.update.sessionUpdate === "user_message_chunk"
    ) {
      return;
    }
    if (!this.process.replaying) this.process.usage.reading(notification.update, this.activeTurnKey);
    this.chunkCounter += 1;
    const projected = projectSessionUpdate(
      notification.update,
      this.process.replaying,
      `chunk-${this.chunkCounter}`,
    );
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
        this.process.configOptions = update.configOptions;
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
      // A waiting permission is session activity: it bumps the inbox so
      // the operator sees the session asking, not just going quiet.
      this.deps.store.touchActivity(this.deps.sid);
      this.emit(projectPermissionRequest(requestId, request));
      console.log(
        `[acp] sid=${this.deps.sid} permission requested (${requestId}: ${request.toolCall.title ?? "untitled"})`,
      );
    });
  }

  private rejectPendingPermissions(): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.emit({
        kind: "permission_resolved",
        requestId: pending.requestId,
        outcome: "cancelled",
      });
    }
    this.pendingPermissions.clear();
  }

  /**
   * §10.4: transport loss during an active prompt is an uncertain
   * outcome — never success. Process loss also fails pending permissions
   * and retires this controller.
   */
  private handleChildExit(code: number): void {
    if (this.process.defunct) return;
    this.process.defunct = true;
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
        }, { status: "absent" },
      );
      this.deps.store.setStatus(this.deps.sid, "idle");
      this.emit({
        kind: "turn_state",
        turnKey,
        state: "unknown",
        detail: `agent process exited (code ${code}) during the turn`,
      });
      console.error(
        `[acp] sid=${this.deps.sid} child exited code=${code} during turn ${turnKey}; outcome unknown`,
      );
    }
    this.process.client?.close();
    this.deps.onDefunct(this.deps.sid);
  }

  private finishTurn(
    turn: AcpTurnRow,
    state: "idle" | "cancelled" | "failed" | "unknown",
    stopReason?: string,
    detail?: string,
  ): void {
    if (!this.process.defunct) this.deps.store.setStatus(turn.sid, "idle");
    this.deps.store.touchActivity(turn.sid);
    this.emit({
      kind: "turn_state",
      turnKey: turn.turn_key,
      state,
      stopReason,
      detail,
    });
    console.log(
      `[acp] sid=${turn.sid} turn=${turn.turn_key} finished state=${state} stop=${stopReason ?? "-"}`,
    );
  }

}

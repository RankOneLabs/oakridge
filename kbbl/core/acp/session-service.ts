// Application service used by HTTP handlers (§8.6) — the replacement for
// the generic half of the legacy SessionManager. Routes never reach into
// an SDK connection; everything goes through this facade. Every prompt is
// dispatched through the controller's accepted-turn loop, so "one active
// prompt per session, ledger as the only deferral" holds by construction.

import { randomUUID } from "node:crypto";

import type { AgentProfile, AgentProfileId } from "./agent-profile";
import { resolveProfile } from "./agent-profile";
import { AcpSessionController } from "./controller";
import type { AcpControllerRegistry } from "./controller-registry";
import type { AcpProcessSupervisor } from "./process-supervisor";
import { startSpecHash, toSnapshot, type AcpSessionStore } from "./store";
import {
  acpError,
  err,
  ok,
  type AcpDispatchStatus,
  type AcpError,
  type AcpSessionRow,
  type AcpSessionSnapshot,
  type AcpSessionStartSpec,
  type AcpTurnRow,
  type AcpUiEvent,
  type AdvanceResult,
  type EnsureResult,
  type FenceContext,
  type InputReceipt,
  type KbblSessionId,
  type ResumableKey,
  type Result,
  type TerminalObservation,
  type TurnKey,
  type UiSessionHistory,
  type WorktreeProvider,
} from "./types";

export interface AcpServiceConfig {
  readonly default_agent: string;
  readonly graceful_kill_ms: number;
  readonly idle_child_ttl_ms: number;
  readonly live_event_buffer: number;
}

export interface AcpSessionServiceDeps {
  readonly store: AcpSessionStore;
  readonly controllers: AcpControllerRegistry;
  readonly profiles: ReadonlyMap<AgentProfileId, AgentProfile>;
  readonly supervisor: AcpProcessSupervisor;
  readonly worktrees: WorktreeProvider;
  readonly config: AcpServiceConfig;
  /**
   * Fired when a session leaves the live set (ended, fenced, or failed).
   * The dispatch-attempt reconciler hangs off this the way it hung off
   * the legacy manager's onRuntimeSessionEnded.
   */
  readonly onSessionEnded?: (sid: KbblSessionId) => void;
}

const OBSERVE_POLL_MS = 100;

function turnToReceipt(row: AcpTurnRow): InputReceipt {
  return {
    sid: row.sid,
    turn_key: row.turn_key,
    payload_hash: row.payload_hash,
    status: row.status,
    created_at: row.created_at,
  };
}

export class AcpSessionService {
  constructor(private readonly deps: AcpSessionServiceDeps) {}

  /** §10.7 boot recovery sweep. Call once before serving requests. */
  recoverOnBoot(): void {
    const swept = this.deps.store.bootSweep();
    console.log(
      `[acp] boot sweep: ${swept.turns_marked_unknown} prompting turn(s) -> unknown, ` +
        `${swept.turns_retained_accepted} accepted turn(s) retained, ` +
        `${swept.sessions_marked_idle} session(s) -> idle, ` +
        `${swept.sessions_marked_failed} provisioning session(s) -> failed`,
    );
  }

  /** Idempotent DBOS ensure (§10.2). */
  async ensureResumableSession(
    key: string,
    spec: AcpSessionStartSpec,
  ): Promise<Result<EnsureResult, AcpError>> {
    const resumableKey = key as ResumableKey;
    const specHash = startSpecHash(spec);
    const sid = randomUUID() as KbblSessionId;
    const profileId = spec.runtime ?? this.deps.config.default_agent;

    const claimed = this.deps.store.claimResumable(resumableKey, {
      sid,
      resumable_key: resumableKey,
      start_spec_hash: specHash,
      agent_profile: profileId,
      name: spec.name ?? key,
      artifact_id: spec.artifact_id ?? null,
      project_workdir: spec.workdir,
      worktree_path: spec.workdir,
      requested_model: spec.model ?? null,
      requested_effort: spec.effort ?? null,
    });

    if (claimed.kind === "spec_conflict") {
      return err(
        acpError(
          "session_key_conflict",
          "service.ensureResumableSession",
          `resumable key "${key}" already claimed with a different start spec`,
          claimed.row.sid,
        ),
      );
    }
    if (claimed.kind === "existing") {
      // Re-touch so retained accepted turns dispatch (§10.7 lazy spawn).
      if (this.hasDispatchableWork(claimed.row)) {
        void this.touchController(claimed.row.sid);
      }
      return ok({ kind: "existing", session: toSnapshot(claimed.row) });
    }

    const provisioned = await this.provision(claimed.row, spec);
    if (!provisioned.ok) return provisioned;
    const controller = provisioned.value;

    const accepted = this.deps.store.acceptTurn({
      sid: claimed.row.sid,
      turn_key: `initial:${key}` as TurnKey,
      source: "initial",
      payload: spec.initial_prompt,
    });
    if (accepted.kind === "payload_conflict") {
      return err(
        acpError(
          "delivery_key_conflict",
          "service.ensureResumableSession",
          "initial turn already recorded with different payload",
          claimed.row.sid,
        ),
      );
    }
    // §10.2 step 13: return immediately; the initial prompt runs async.
    void controller.dispatchAcceptedTurns();
    const row = this.deps.store.getSession(claimed.row.sid);
    return ok({
      kind: "created",
      session: toSnapshot(row ?? claimed.row),
    });
  }

  /** Browser-created session (no resumable key). */
  async createSession(
    spec: AcpSessionStartSpec,
  ): Promise<Result<AcpSessionSnapshot, AcpError>> {
    const sid = randomUUID() as KbblSessionId;
    const profileId = spec.runtime ?? this.deps.config.default_agent;
    const row = this.deps.store.insertSession({
      sid,
      resumable_key: null,
      start_spec_hash: null,
      agent_profile: profileId,
      name: spec.name ?? sid.slice(0, 8),
      artifact_id: spec.artifact_id ?? null,
      project_workdir: spec.workdir,
      worktree_path: spec.workdir,
      requested_model: spec.model ?? null,
      requested_effort: spec.effort ?? null,
    });

    const provisioned = await this.provision(row, spec);
    if (!provisioned.ok) return provisioned;

    if (spec.initial_prompt.length > 0) {
      this.deps.store.acceptTurn({
        sid,
        turn_key: `initial:${sid}` as TurnKey,
        source: "initial",
        payload: spec.initial_prompt,
      });
      void provisioned.value.dispatchAcceptedTurns();
    }
    const fresh = this.deps.store.getSession(sid);
    return ok(toSnapshot(fresh ?? row));
  }

  listSessions(): AcpSessionSnapshot[] {
    return this.deps.store.listSessions().map(toSnapshot);
  }

  getSession(sid: string): AcpSessionSnapshot | null {
    const row = this.deps.store.getSession(sid as KbblSessionId);
    return row ? toSnapshot(row) : null;
  }

  /**
   * Settlement read for orchestrator dispatch attempts and boot
   * reconciliation: completion is the initial turn settling, never the
   * session ending (a durable session stays idle/resumable after its work
   * is done). Null when the sid is not an ACP session.
   */
  dispatchStatus(sid: string): AcpDispatchStatus | null {
    const row = this.deps.store.getSession(sid as KbblSessionId);
    if (!row) return null;
    const observed = this.classifyInitialTurn(row);
    switch (observed.kind) {
      case "succeeded":
        return "completed";
      case "failed":
        return "failed";
      case "pending":
        return "running";
    }
  }

  listByArtifact(artifactId: string): AcpSessionSnapshot[] {
    return this.deps.store.listByArtifact(artifactId).map(toSnapshot);
  }

  listProfiles(): Array<{ id: string; label: string; enabled: boolean }> {
    return [...this.deps.profiles.values()].map((profile) => ({
      id: profile.id,
      label: profile.label,
      enabled: profile.enabled,
    }));
  }

  get defaultAgent(): string {
    return this.deps.config.default_agent;
  }

  /**
   * Input delivery (§11.3). With a `delivery_key` this is a durable DBOS
   * collaboration delivery: accepted even while a turn is active, then
   * dispatched serially. Otherwise it is operator input, which answers
   * busy instead of queueing; `client_message_id` makes an operator turn
   * idempotent (§14.5) without changing its non-queueing semantics.
   */
  async sendInput(
    sid: string,
    input: string,
    opts?: { delivery_key?: string; client_message_id?: string },
  ): Promise<Result<InputReceipt, AcpError>> {
    const inputKey = opts?.delivery_key;
    const row = this.deps.store.getSession(sid as KbblSessionId);
    if (!row) {
      return err(
        acpError("session_not_found", "service.sendInput", `no session ${sid}`),
      );
    }
    if (row.status === "fenced" || row.fenced_by !== null) {
      return err(
        acpError(
          "session_fenced",
          "service.sendInput",
          `session is fenced by ${row.fenced_by ?? "unknown"}`,
          row.sid,
        ),
      );
    }
    if (row.status === "ended" || row.status === "failed") {
      return err(
        acpError(
          "session_not_found",
          "service.sendInput",
          `session is ${row.status}`,
          row.sid,
        ),
      );
    }

    const isCollaboration = inputKey !== undefined;
    const busy =
      row.status === "prompting" ||
      (this.deps.controllers.getLive(row.sid)?.isPromptActive ?? false);
    if (!isCollaboration && busy) {
      return err(
        acpError(
          "session_busy",
          "service.sendInput",
          "a turn is active; operator input does not queue",
          row.sid,
        ),
      );
    }

    const turnKey = (inputKey ??
      `operator:${opts?.client_message_id ?? randomUUID()}`) as TurnKey;
    const accepted = this.deps.store.acceptTurn({
      sid: row.sid,
      turn_key: turnKey,
      source: isCollaboration ? "collaboration" : "operator",
      payload: input,
    });
    if (accepted.kind === "payload_conflict") {
      return err(
        acpError(
          "delivery_key_conflict",
          "service.sendInput",
          `input key "${turnKey}" already used with different text`,
          row.sid,
        ),
      );
    }
    if (accepted.kind === "existing") {
      return ok(turnToReceipt(accepted.row));
    }

    // Durable now; dispatch when the controller is (or becomes) idle.
    const touched = await this.touchController(row.sid);
    if (touched.ok) void touched.value.dispatchAcceptedTurns();
    else if (!isCollaboration) {
      // Operator input never queues (§11.3): a turn whose touch failed
      // must not sit accepted and dispatch on some later touch after the
      // operator was already told it failed.
      this.deps.store.completeTurn(row.sid, accepted.row.turn_key, {
        status: "failed",
        failure_code: touched.error.code,
        failure_detail: touched.error.detail,
      });
      return touched;
    }
    return ok(turnToReceipt(accepted.row));
  }

  resolvePermission(
    sid: string,
    requestId: string,
    optionId: string,
  ): Result<void, AcpError> {
    const controller = this.deps.controllers.getLive(sid as KbblSessionId);
    if (!controller) {
      return err(
        acpError(
          "session_not_found",
          "service.resolvePermission",
          `no live controller for ${sid}`,
        ),
      );
    }
    return controller.resolvePermission(requestId, optionId);
  }

  /** Normal user stop — session/cancel, not a fence (guardrail 15). */
  async cancelTurn(sid: string): Promise<Result<void, AcpError>> {
    const controller = this.deps.controllers.getLive(sid as KbblSessionId);
    if (!controller || !controller.isPromptActive) return ok(undefined);
    return controller.cancelActiveTurn();
  }

  /**
   * Close, or fence when a FenceContext is supplied (§10.5). An unknown
   * or already-closed session remains success — matching the DBOS
   * cancellation contract.
   */
  async closeSession(
    sid: string,
    fence?: FenceContext,
  ): Promise<Result<void, AcpError>> {
    const row = this.deps.store.getSession(sid as KbblSessionId);
    if (!row) return ok(undefined);
    const wasLive =
      row.status !== "ended" && row.status !== "fenced" && row.status !== "failed";
    const controller = this.deps.controllers.getLive(row.sid);
    if (fence) {
      if (controller) {
        await controller.fence(fence.fenced_by);
      } else if (row.status !== "fenced") {
        this.deps.store.setFencedBy(row.sid, fence.fenced_by);
        this.deps.store.markEnded(row.sid, "fenced", "fenced", fence.fenced_by);
      }
      if (wasLive) this.deps.onSessionEnded?.(row.sid);
      return ok(undefined);
    }
    if (controller) await controller.closeChild();
    if (row.status !== "ended" && row.status !== "fenced") {
      this.deps.store.markEnded(row.sid, "ended", "user_closed");
    }
    if (wasLive) this.deps.onSessionEnded?.(row.sid);
    return ok(undefined);
  }

  /**
   * §10.6 operator advance: an explicit escape hatch for a key whose
   * session can no longer make progress. Fences whatever the key points
   * at, then detaches the key so the next ensure creates a fresh session.
   * Never reachable by an ensure retry.
   */
  async advanceResumable(key: string): Promise<AdvanceResult> {
    const row = this.deps.store.getByResumableKey(key as ResumableKey);
    if (!row) return { kind: "not_found" };
    await this.closeSession(row.sid, { fenced_by: `advance:${key}` });
    this.deps.store.clearResumableKey(row.sid);
    const after = this.deps.store.getSession(row.sid);
    return { kind: "advanced", session: toSnapshot(after ?? row) };
  }

  /**
   * Operator hard delete: fence out any live child, best-effort worktree
   * removal, then drop the row (turn ledger goes with it).
   */
  async purgeSession(sid: string): Promise<Result<boolean, AcpError>> {
    const row = this.deps.store.getSession(sid as KbblSessionId);
    if (!row) return ok(false);
    await this.closeSession(sid);
    await this.deps.worktrees.remove?.({
      project_workdir: row.project_workdir,
      worktree_path: row.worktree_path,
      worktree_branch: row.worktree_branch,
    });
    this.deps.store.deleteSession(row.sid);
    return ok(true);
  }

  /** Live projection epoch (§14.4), or null with no live controller. */
  streamEpoch(sid: string): string | null {
    return this.deps.controllers.getLive(sid as KbblSessionId)?.streamEpoch ?? null;
  }

  /**
   * Bounded observation of the INITIAL turn (§11.2): pending until that
   * turn has a known final outcome; the child staying alive afterwards is
   * not non-terminal. Also the lazy-spawn touch that dispatches retained
   * accepted turns (§10.7).
   */
  async observeInitialTurn(
    sid: string,
    waitMs: number,
  ): Promise<Result<TerminalObservation, AcpError>> {
    const kbblSid = sid as KbblSessionId;
    const first = this.deps.store.getSession(kbblSid);
    if (!first) {
      return err(
        acpError(
          "session_not_found",
          "service.observeInitialTurn",
          `no session ${sid}`,
        ),
      );
    }
    if (this.hasDispatchableWork(first)) void this.touchController(kbblSid);

    const deadline = Date.now() + Math.max(0, waitMs);
    for (;;) {
      const row = this.deps.store.getSession(kbblSid);
      if (!row) {
        return err(
          acpError(
            "session_not_found",
            "service.observeInitialTurn",
            `session ${sid} disappeared`,
          ),
        );
      }
      const observation = this.classifyInitialTurn(row);
      if (observation.kind !== "pending" || Date.now() >= deadline) {
        return ok(observation);
      }
      await new Promise((resolve) => setTimeout(resolve, OBSERVE_POLL_MS));
    }
  }

  /**
   * History via the agent's own store (§10.3): live controllers answer
   * from the projection buffer; otherwise a fresh child replays
   * session/load. A failed load reports an expired history, not an error.
   */
  async loadHistory(sid: string): Promise<Result<UiSessionHistory, AcpError>> {
    const kbblSid = sid as KbblSessionId;
    const row = this.deps.store.getSession(kbblSid);
    if (!row) {
      return err(
        acpError(
          "session_not_found",
          "service.loadHistory",
          `no session ${sid}`,
        ),
      );
    }
    const live = this.deps.controllers.getLive(kbblSid);
    if (live) {
      return ok({ sid: kbblSid, events: live.snapshotEvents(), expired: false });
    }
    const touched = await this.touchController(kbblSid);
    if (!touched.ok) {
      if (touched.error.code === "acp_session_load_failed") {
        return ok({ sid: kbblSid, events: [], expired: true });
      }
      return touched;
    }
    return ok({
      sid: kbblSid,
      events: touched.value.snapshotEvents(),
      expired: false,
    });
  }

  async setConfigOption(
    sid: string,
    configId: string,
    value: string | boolean,
  ): Promise<Result<void, AcpError>> {
    const touched = await this.touchController(sid as KbblSessionId);
    if (!touched.ok) return touched;
    return touched.value.setConfigOption(configId, value);
  }

  subscribe(
    sid: string,
    listener: (event: AcpUiEvent) => void,
  ): (() => void) | null {
    const controller = this.deps.controllers.getLive(sid as KbblSessionId);
    return controller ? controller.subscribe(listener) : null;
  }

  /** §10.8: close children idle past the TTL. Wire to a timer at startup. */
  async reapIdleChildren(now = Date.now()): Promise<void> {
    for (const row of this.deps.store.listSessions()) {
      if (row.status !== "idle") continue;
      const controller = this.deps.controllers.getLive(row.sid);
      if (!controller || controller.isPromptActive) continue;
      if (controller.hasSubscribers) continue;
      if (this.deps.store.listAcceptedTurns(row.sid).length > 0) continue;
      const idleMs = now - Date.parse(row.last_activity_at);
      if (idleMs < this.deps.config.idle_child_ttl_ms) continue;
      console.log(`[acp] sid=${row.sid} idle ${idleMs}ms; reaping child`);
      await controller.closeChild();
    }
  }

  async shutdown(): Promise<void> {
    await this.deps.controllers.shutdownAll();
  }

  // === internals ===

  /** §10.2 steps 3–10 for a fresh `provisioning` row. Failures become a
   * visible failed session, never an invisible claimed key. */
  private async provision(
    row: AcpSessionRow,
    spec: AcpSessionStartSpec,
  ): Promise<Result<AcpSessionController, AcpError>> {
    const profile = resolveProfile(this.deps.profiles, row.agent_profile);
    if (!profile.ok) return this.failProvisioning(row, profile.error);

    const worktree = await this.deps.worktrees.resolve(row.sid, spec);
    if (!worktree.ok) return this.failProvisioning(row, worktree.error);
    this.deps.store.setWorktree(row.sid, {
      worktree_path: worktree.value.worktree_path,
      worktree_branch: worktree.value.worktree_branch,
      worktree_base_ref: worktree.value.worktree_base_ref,
      parent_sid: worktree.value.parent_sid,
      project_workdir: worktree.value.project_workdir,
    });

    const created = await this.deps.controllers.getOrCreate(row.sid, async () => {
      const controller = new AcpSessionController({
        sid: row.sid,
        profile: profile.value,
        store: this.deps.store,
        supervisor: this.deps.supervisor,
        config: {
          live_event_buffer: this.deps.config.live_event_buffer,
          close_grace_ms: this.deps.config.graceful_kill_ms,
        },
        onDefunct: (sid) => this.deps.controllers.remove(sid),
      });
      const started = await controller.start(worktree.value.worktree_path, {
        kind: "new",
      });
      if (!started.ok) return started;
      const configured = await controller.applyRequestedConfig(
        row.requested_model,
        row.requested_effort,
      );
      if (!configured.ok) {
        await controller.closeChild();
        return configured;
      }
      return ok(controller);
    });
    if (!created.ok) return this.failProvisioning(row, created.error);

    this.deps.store.setStatus(row.sid, "idle");
    console.log(
      `[acp] sid=${row.sid} provisioned profile=${row.agent_profile} pid=${created.value.childPid}`,
    );
    return created;
  }

  private failProvisioning(
    row: AcpSessionRow,
    error: AcpError,
  ): Result<never, AcpError> {
    this.deps.store.markEnded(row.sid, "failed", error.code);
    console.error(
      `[acp] sid=${row.sid} provisioning failed: ${error.code} (${error.detail})`,
    );
    this.deps.onSessionEnded?.(row.sid);
    return err({ ...error, sid: row.sid });
  }

  /** §10.3 lazy respawn: fresh child + session/load for an idle session. */
  private async touchController(
    sid: KbblSessionId,
  ): Promise<Result<AcpSessionController, AcpError>> {
    const live = this.deps.controllers.getLive(sid);
    if (live) return ok(live);
    const row = this.deps.store.getSession(sid);
    if (!row) {
      return err(
        acpError(
          "session_not_found",
          "service.touchController",
          `no session ${sid}`,
        ),
      );
    }
    if (row.acp_session_id === null) {
      return err(
        acpError(
          "acp_session_load_failed",
          "service.touchController",
          "session has no stored ACP session id",
          sid,
        ),
      );
    }
    const acpSessionId = row.acp_session_id;
    const profile = resolveProfile(this.deps.profiles, row.agent_profile);
    if (!profile.ok) return profile;

    const created = await this.deps.controllers.getOrCreate(sid, async () => {
      const controller = new AcpSessionController({
        sid,
        profile: profile.value,
        store: this.deps.store,
        supervisor: this.deps.supervisor,
        config: {
          live_event_buffer: this.deps.config.live_event_buffer,
          close_grace_ms: this.deps.config.graceful_kill_ms,
        },
        onDefunct: (defunctSid) => this.deps.controllers.remove(defunctSid),
      });
      const started = await controller.start(row.worktree_path, {
        kind: "load",
        acp_session_id: acpSessionId,
      });
      if (!started.ok) return started;
      return ok(controller);
    });
    if (created.ok) void created.value.dispatchAcceptedTurns();
    return created;
  }

  private hasDispatchableWork(row: AcpSessionRow): boolean {
    return (
      row.fenced_by === null &&
      (row.status === "idle" || row.status === "prompting") &&
      this.deps.controllers.getLive(row.sid) === null &&
      this.deps.store.listAcceptedTurns(row.sid).length > 0
    );
  }

  private classifyInitialTurn(row: AcpSessionRow): TerminalObservation {
    const session = toSnapshot(row);
    if (row.status === "failed") {
      return {
        kind: "failed",
        session,
        failure_code:
          row.end_reason === "kbbl_restart" ? "kbbl_restart" : "agent_spawn_failed",
        failure_detail: row.end_reason ?? "session failed during provisioning",
      };
    }
    const turn = this.deps.store.getInitialTurn(row.sid);
    // A closed/fenced session can never complete its initial turn: pending
    // here would be a wait on a state that cannot arrive. Success stays
    // success (the turn finished before the close); everything else is a
    // terminal fence/close outcome.
    if (
      (row.status === "fenced" || row.status === "ended") &&
      turn?.status !== "succeeded"
    ) {
      return {
        kind: "failed",
        session,
        failure_code: "session_fenced",
        failure_detail: `session was ${row.status} (${row.end_reason ?? "closed"}) before the initial turn completed`,
      };
    }
    if (!turn) return { kind: "pending", session };
    switch (turn.status) {
      case "succeeded":
        return { kind: "succeeded", session };
      case "failed":
      case "unknown":
        return {
          kind: "failed",
          session,
          failure_code: turn.failure_code ?? "acp_prompt_failed",
          failure_detail:
            turn.failure_detail ?? `initial turn is ${turn.status}`,
        };
      case "cancelled":
        return {
          kind: "failed",
          session,
          failure_code: "acp_prompt_failed",
          failure_detail: "initial turn was cancelled",
        };
      default:
        return { kind: "pending", session };
    }
  }
}

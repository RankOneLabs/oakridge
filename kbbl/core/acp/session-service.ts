import { buildEpochFrame, toWireFrames, type SessionEpochFrame, type SessionWireFrame } from "./session-wire";
import { selectItemPage, type EpochChanged, type ItemPage } from "./transcript-page";
import type { StreamEpoch, TranscriptEmission } from "./transcript-model";
import { randomUUID } from "node:crypto";
import { AcpSessionReads } from "#kbbl/core/acp/session-reads";
import { AcpSessionHistory } from "#kbbl/core/acp/session-history";
export type { HistoryLease } from "#kbbl/core/acp/session-history";
import { AcpSessionProvisioner } from "#kbbl/core/acp/session-provisioner";
import { createSessionController } from "./session-controller";
import { removeSessionSkills, type SessionIntegrationConfig } from "./session-integration";
import { sha256Hex } from "./start-spec-hash";
import { toSnapshot, turnToOpenTurn, turnToReceipt } from "./pwa-wire";
// Application service used by HTTP handlers (§8.6). Routes never reach into
// an SDK connection; everything goes through this facade. Every prompt is
// dispatched through the controller's accepted-turn loop, so "one active
// prompt per session, ledger as the only deferral" holds by construction.

import type { AgentProfile, AgentProfileId } from "./agent-profile";
import { resolveProfile } from "./agent-profile";
import type { AcpSessionController } from "./controller";
import { configOptionCategory } from "./config-option-resolver";
import type { AcpControllerRegistry } from "./controller-registry";
import type { AcpProcessSupervisor } from "./process-supervisor";
import type { SessionSummaryGenerator } from "./session-summary";
import type { AcpSessionStore } from "./store";
import {
  acpError,
  err,
  ok,
  type AcpError,
  type AcpSessionRow,
  type AcpSessionSnapshot,
  type AdvanceResult,
  type FenceContext,
  type InputReceipt,
  type KbblSessionId,
  type ResumableKey,
  type Result,
  type TurnKey,
  type WorktreeProvider,
} from "./types";

export interface AcpServiceConfig {
  readonly default_agent: string;
  readonly graceful_kill_ms: number;
  readonly idle_child_ttl_ms: number;
  readonly live_item_buffer: number;
  readonly initial_item_window: number;
  readonly item_page_limit: number;
  readonly item_page_limit_max: number;
}

export interface AcpSessionServiceDeps {
  readonly integration?: SessionIntegrationConfig;
  readonly store: AcpSessionStore;
  readonly controllers: AcpControllerRegistry;
  readonly profiles: ReadonlyMap<AgentProfileId, AgentProfile>;
  readonly supervisor: AcpProcessSupervisor;
  readonly worktrees: WorktreeProvider;
  readonly config: AcpServiceConfig;
  readonly summary_generators?: readonly SessionSummaryGenerator[];
}

export interface SessionStreamLease {
  epoch_frame: SessionEpochFrame;
  release(): Promise<void>;
}

interface ItemPageQuery {
  epoch: string;
  before_seq: number;
  limit: number;
}

export class AcpSessionService {
  private readonly reads: AcpSessionReads;
  private readonly history: AcpSessionHistory;
  private readonly provisioner: AcpSessionProvisioner;
  constructor(private readonly deps: AcpSessionServiceDeps) {
    this.reads = new AcpSessionReads(deps.store);
    this.history = new AcpSessionHistory(deps, { touchController: (sid, signal) => this.touchController(sid, signal) });
    this.provisioner = new AcpSessionProvisioner(deps, { touchController: sid => this.touchController(sid) });
  }
  ensureResumableSession(...args: Parameters<AcpSessionProvisioner["ensureResumableSession"]>) {
    return this.provisioner.ensureResumableSession(...args);
  }
  createSession(...args: Parameters<AcpSessionProvisioner["createSession"]>) { return this.provisioner.createSession(...args); }
  observeInitialTurn(...args: Parameters<AcpSessionProvisioner["observeInitialTurn"]>) { return this.provisioner.observeInitialTurn(...args); }
  loadHistory(...args: Parameters<AcpSessionHistory["loadHistory"]>) { return this.history.loadHistory(...args); }
  loadResumeHistory(...args: Parameters<AcpSessionHistory["loadResumeHistory"]>) { return this.history.loadResumeHistory(...args); }
  acquireHistory(...args: Parameters<AcpSessionHistory["acquireHistory"]>) { return this.history.acquireHistory(...args); }

  get transcriptLimits(): Readonly<Pick<AcpServiceConfig, "initial_item_window" | "item_page_limit" | "item_page_limit_max">> {
    return this.deps.config;
  }

  async openSessionStream(
    sid: string,
    listener: (frames: readonly SessionWireFrame[]) => void,
    signal?: AbortSignal,
  ): Promise<Result<SessionStreamLease, AcpError>> {
    let unsubscribe: (() => void) | undefined;
    const detach = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      signal?.removeEventListener("abort", detach);
    };
    // History also releases on abort. Detach first so a display-only child
    // is not kept alive by this stream's own subscription.
    signal?.addEventListener("abort", detach, { once: true });
    const acquired = await this.acquireHistory(sid, signal);
    if (!acquired.ok) {
      detach();
      return acquired;
    }

    const lease = acquired.value;
    let history = lease.history;
    const controller = this.deps.controllers.getLive(history.sid);
    if (!signal?.aborted && history.kind === "transcript" && controller?.streamEpoch === history.transcript.stream_epoch) {
      // No asynchronous work between the snapshot and the live subscription.
      const transcript = controller.snapshotTranscript();
      unsubscribe = controller.subscribe(({ frames }) => {
        listener(toWireFrames(frames, controller.snapshotTranscript().items));
      });
      history = {
        ...history,
        transcript,
        openTurns: this.deps.store.listOpenTurns(history.sid).map(turnToOpenTurn),
      };
    }
    return ok({
      epoch_frame: buildEpochFrame({
        history,
        stream_epoch: controller?.streamEpoch ?? null,
        initial_item_window: this.transcriptLimits.initial_item_window,
      }),
      release: () => {
        detach();
        return lease.release();
      },
    });
  }

  readItemPage(sid: string, query: ItemPageQuery): Result<ItemPage | EpochChanged, AcpError> {
    const sessionId = sid as KbblSessionId;
    if (!this.deps.store.getSession(sessionId)) {
      return err(acpError("session_not_found", "service.readItemPage", `no session ${sid}`));
    }
    const live = this.deps.controllers.getLive(sessionId);
    const retained = this.history.getRetainedSnapshot(sessionId);
    const matching = live?.streamEpoch === query.epoch ? live.snapshotTranscript() : retained;
    if (matching?.stream_epoch !== query.epoch) {
      return ok({ kind: "epoch_changed", stream_epoch: live?.streamEpoch ?? retained?.stream_epoch ?? null });
    }
    return ok({ kind: "page", stream_epoch: matching.stream_epoch, ...selectItemPage({ ...query, items: matching.items }) });
  }

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

  readPromptTurns(sid: string) { return this.reads.readPromptTurns(sid); }

  listSessions() { return this.reads.listSessions(); }

  listSessionArchives() { return this.reads.listSessionArchives(); }

  archiveSession(sid: string) { return this.reads.archiveSession(sid); }

  readUsage(sid: string) { return this.reads.readUsage(sid); }

  getSession(sid: string) { return this.reads.getSession(sid); }

  listByArtifact(artifactId: string) { return this.reads.listByArtifact(artifactId); }

  /** Permission requests awaiting an operator answer (0 with no live
   * controller — pending permissions do not survive the child). */
  pendingPermissionCount(sid: string): number {
    return (
      this.deps.controllers.getLive(sid as KbblSessionId)
        ?.pendingPermissionCount ?? 0
    );
  }

  /**
   * Coarse §14.1 change feed: fires after any sessions-table write. The
   * inbox re-reads snapshots on each tick; there are no delta payloads.
   */
  subscribeSessionsChanged(listener: () => void): () => void {
    return this.deps.store.subscribeSessionsChanged(listener);
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
   * Input delivery (§11.3). Operator and collaboration turns are accepted
   * durably even while another turn is active, then dispatched serially.
   * `client_message_id` makes an operator turn idempotent (§14.5).
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
    const turnKey = (inputKey ??
      `operator:${opts?.client_message_id ?? randomUUID()}`) as TurnKey;

    // §14.5 idempotency: a retry of an already-recorded operator turn
    // returns its stored receipt (or conflicts on different text).
    if (!isCollaboration && opts?.client_message_id !== undefined) {
      const existing = this.deps.store.getTurn(row.sid, turnKey);
      if (existing) {
        if (existing.payload_hash !== sha256Hex(input)) {
          return err(
            acpError(
              "delivery_key_conflict",
              "service.sendInput",
              `input key "${turnKey}" already used with different text`,
              row.sid,
            ),
          );
        }
        return ok(turnToReceipt(existing));
      }
    }

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
    // A failed immediate touch does not revoke durable acceptance. The
    // retained turn is safe to dispatch after controller recovery because
    // it has not crossed the accepted -> prompting boundary.
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
    const controller = this.deps.controllers.getLive(row.sid);
    if (fence) {
      if (controller) {
        // Fence ownership is durable before summary generation awaits agent
        // or storage work, so no new operator input can race terminalization.
        this.deps.store.setFencedBy(row.sid, fence.fenced_by);
        await this.history.captureSummary(controller);
        await controller.fence(fence.fenced_by);
      } else if (row.status !== "fenced") {
        this.deps.store.setFencedBy(row.sid, fence.fenced_by);
        await this.history.captureColdSummary(this.deps.store.getSession(row.sid) ?? row);
        this.deps.store.markEnded(row.sid, {
          status: "fenced",
          reason: "fenced",
          fenced_by: fence.fenced_by,
        });
      }
      return ok(undefined);
    }
    if (controller) {
      await this.history.captureSummary(controller);
      await controller.closeChild();
    } else if (row.status !== "ended" && row.status !== "fenced") {
      await this.history.captureColdSummary(row);
    }
    if (row.status !== "ended" && row.status !== "fenced") {
      this.deps.store.markEnded(row.sid, { status: "ended", reason: "user_closed" });
    }
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
   * A session that ended before its agent reported an ACP session id never
   * accepted its initial prompt: it has no transcript to resume and no work
   * that could still be running. A revive could only refuse it, so a
   * reviving ensure fences it and detaches its key instead, and the next
   * ensure provisions a fresh session. Unlike `advanceResumable`, no agent
   * that may still be working is left behind.
   */
  async releaseUnprovisioned(key: string): Promise<boolean> {
    const row = this.deps.store.getByResumableKey(key as ResumableKey);
    if (!row || !this.isUnprovisioned(row)) return false;
    await this.closeSession(row.sid, { fenced_by: `unprovisioned:${key}` });
    this.deps.store.clearResumableKey(row.sid);
    console.log(`[acp] sid=${row.sid} released unprovisioned session for key=${key}`);
    return true;
  }

  private isUnprovisioned(row: AcpSessionRow): boolean {
    return (row.status === "failed" || row.status === "ended")
      && row.fenced_by === null
      && row.acp_session_id === null
      && this.deps.store.getInitialTurn(row.sid) === null;
  }

  /** Collaboration resumes the pinned sid and ACP transcript without replaying the initial turn. */
  async reviveResumable(key: string): Promise<Result<AcpSessionSnapshot, AcpError>> {
    const row = this.deps.store.getByResumableKey(key as ResumableKey);
    if (!row) return err(acpError("session_not_found", "service.reviveResumable", `no resumable session for ${key}`));
    if (row.fenced_by !== null || row.status === "fenced")
      return err(acpError("session_fenced", "service.reviveResumable", `session is fenced`, row.sid));
    if (row.status !== "ended" && row.status !== "failed") return ok(toSnapshot(row));
    if (row.acp_session_id === null)
      return err(acpError("acp_session_load_failed", "service.reviveResumable", "session has no stored ACP session id", row.sid));
    const loaded = await this.touchController(row.sid, undefined, true);
    if (!loaded.ok) return loaded;
    this.deps.store.reviveEnded(row.sid);
    const revived = this.deps.store.getSession(row.sid);
    if (!revived || revived.fenced_by !== null || revived.status === "fenced") {
      await loaded.value.closeChild();
      return err(acpError("session_fenced", "service.reviveResumable", "session was fenced during resume", row.sid));
    }
    return ok(toSnapshot(revived));
  }

  /**
   * Operator hard delete: fence out any live child, best-effort removal of
   * its session skills and worktree, then drop the row (turn ledger goes with it).
   */
  async purgeSession(sid: string): Promise<Result<boolean, AcpError>> {
    const row = this.deps.store.markPurgeStarted(sid as KbblSessionId);
    if (!row) return ok(false);
    await this.closeSession(sid);
    const skillsRemoved = removeSessionSkills(row.sid, this.deps.integration);
    if (!skillsRemoved.ok) console.warn(`[acp] sid=${row.sid} purge left session skills: ${skillsRemoved.error}`);
    const hasOtherOwner = row.worktree_branch !== null
      && this.deps.store.hasOtherWorktreeOwner(
        row.sid,
        row.worktree_path,
        row.worktree_branch,
      );
    if (!hasOtherOwner) {
      await this.deps.worktrees.remove?.({
        project_workdir: row.project_workdir,
        worktree_path: row.worktree_path,
        worktree_branch: row.worktree_branch,
      });
    }
    this.deps.store.deleteSession(row.sid);
    this.history.dropRetainedSnapshot(row.sid);
    return ok(true);
  }

  /** Live projection epoch (§14.4), or null with no live controller. */
  streamEpoch(sid: string): StreamEpoch | null {
    return this.deps.controllers.getLive(sid as KbblSessionId)?.streamEpoch ?? null;
  }

  async setConfigOption(
    sid: string,
    configId: string,
    value: string | boolean,
  ): Promise<Result<void, AcpError>> {
    const touched = await this.touchController(sid as KbblSessionId);
    if (!touched.ok) return touched;
    const controller = touched.value;
    const applied = await controller.setConfigOption(configId, value);
    if (!applied.ok) return applied;
    // The operator's mode choice outlives this child: a respawn re-applies
    // requested_mode, so a toggle sticks for the session's life.
    if (
      typeof value === "string" &&
      configOptionCategory(controller.liveConfigOptions, configId) === "mode"
    ) {
      this.deps.store.setRequestedMode(sid as KbblSessionId, value);
    }
    return ok(undefined);
  }

  subscribe(
    sid: string,
    listener: (emission: TranscriptEmission) => void,
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

  /** §10.3 lazy respawn: fresh child + session/load for an idle session. */
  private async touchController(
    sid: KbblSessionId,
    loadSignal?: AbortSignal,
    allowTerminalResume = false,
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
    if (
      (row.status === "ended" && !allowTerminalResume) ||
      row.status === "fenced" ||
      (row.status === "failed" && !allowTerminalResume) ||
      row.fenced_by !== null
    ) {
      return err(
        acpError(
          "session_not_found",
          "service.touchController",
          `session is ${row.status}`,
          sid,
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
      const controller = createSessionController({ row, profile: profile.value, deps: this.deps });
      // Some agents do not persist session/new until the first prompt. The
      // durable ledger proves whether any prompt may have reached the agent;
      // only a never-dispatched session can safely start afresh on this same
      // worktree. Accepted input keeps its original key and dispatches once.
      const hasDispatchedTurns = this.deps.store.hasDispatchedTurns(sid);
      const started = await controller.start(row.worktree_path, hasDispatchedTurns
        ? { kind: "load", acp_session_id: acpSessionId }
        : { kind: "new" }, loadSignal);
      if (!started.ok) return started;
      // session/load may report the agent's default config instead of the
      // selection used before the child exited. The durable requested values
      // remain authoritative across both new-session recovery and reload.
      const configured = await controller.applyRequestedConfig(row);
      if (!configured.ok) {
        await controller.closeChild();
        return configured;
      }
      return ok(controller);
    });
    if (created.ok) void created.value.dispatchAcceptedTurns();
    return created;
  }

}

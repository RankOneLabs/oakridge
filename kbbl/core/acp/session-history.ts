import type { AcpSessionServiceDeps } from "#kbbl/core/acp/session-service";
import type { AcpSessionController } from "#kbbl/core/acp/controller";
import { createSessionController } from "#kbbl/core/acp/session-controller";
import { resolveProfile } from "#kbbl/core/acp/agent-profile";
import { turnToOpenTurn } from "#kbbl/core/acp/pwa-wire";
import { FinalResponseSummaryGenerator, generateSessionSummary, ManualCompactionSummaryGenerator, type SessionSummaryGenerator } from "#kbbl/core/acp/session-summary";
import { acpError, err, ok, type AcpError, type AcpSessionRow, type KbblSessionId, type Result, type UiSessionHistory } from "#kbbl/core/acp/types";

export interface HistoryLease {
  readonly history: UiSessionHistory;
  release(): Promise<void>;
}
export interface SessionHistoryCallbacks {
  touchController(sid: KbblSessionId, signal?: AbortSignal): Promise<Result<AcpSessionController, AcpError>>;
}

/** Transcript loading, display-only process ownership and terminal summary capture. */
export class AcpSessionHistory {
  private readonly historyConsumers = new Map<KbblSessionId, number>();
  private readonly coldHistoryLoads = new Map<KbblSessionId, AbortController>();
  private readonly summaryGenerators: readonly SessionSummaryGenerator[];
  constructor(private readonly deps: AcpSessionServiceDeps, private readonly callbacks: SessionHistoryCallbacks) {
    this.summaryGenerators = deps.summary_generators ?? [new ManualCompactionSummaryGenerator(), new FinalResponseSummaryGenerator()];
  }
  /**
   * History via the agent's own store (§10.3): live controllers answer
   * from the projection buffer; otherwise a fresh child replays
   * session/load. A failed load reports an expired history, not an error.
   */
  async loadHistory(
    sid: string,
    loadSignal?: AbortSignal,
  ): Promise<Result<UiSessionHistory, AcpError>> {
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
      return ok({
        kind: "transcript",
        sid: kbblSid,
        events: live.snapshotEvents(),
        openTurns: this.deps.store.listOpenTurns(kbblSid).map(turnToOpenTurn),
        expired: false,
        summary: null,
      });
    }
    if (
      row.status === "ended" ||
      row.status === "fenced" ||
      row.status === "failed"
    ) {
      return this.loadTerminalHistory(row, loadSignal);
    }
    const touched = await this.callbacks.touchController(kbblSid, loadSignal);
    if (!touched.ok) {
      if (touched.error.code === "acp_session_load_failed") {
        return ok({
          kind: "unavailable",
          sid: kbblSid,
          events: [],
          openTurns: this.deps.store.listOpenTurns(kbblSid).map(turnToOpenTurn),
          expired: true,
          summary: null,
          reason: "agent_history_unavailable",
        });
      }
      return touched;
    }
    return ok({
      kind: "transcript",
      sid: kbblSid,
      events: touched.value.snapshotEvents(),
      openTurns: this.deps.store.listOpenTurns(kbblSid).map(turnToOpenTurn),
      expired: false,
      summary: null,
    });
  }

  /** Resume needs the complete ACP replay, including events evicted from a
   * live controller's bounded display buffer. The replay child is private and
   * never takes ownership of the parent's active session. */
  async loadResumeHistory(
    sid: string,
    loadSignal?: AbortSignal,
  ): Promise<Result<UiSessionHistory, AcpError>> {
    const kbblSid = sid as KbblSessionId;
    const row = this.deps.store.getSession(kbblSid);
    if (!row) return err(acpError("session_not_found", "service.loadResumeHistory", `no session ${sid}`));
    const openTurns = this.deps.store.listOpenTurns(kbblSid).map(turnToOpenTurn);
    const fallback = (reason: "missing_acp_session_id" | "agent_history_unavailable"): UiSessionHistory => {
      const summary = this.deps.store.getSessionSummary(kbblSid);
      return summary
        ? { kind: "summary", sid: kbblSid, events: [], openTurns, expired: true, summary }
        : { kind: "unavailable", sid: kbblSid, events: [], openTurns, expired: true, summary: null, reason };
    };
    if (loadSignal?.aborted) return err(acpError("acp_session_load_failed", "service.loadResumeHistory", "resume request was cancelled", kbblSid));
    if (row.acp_session_id === null) return ok(fallback("missing_acp_session_id"));
    const profile = resolveProfile(this.deps.profiles, row.agent_profile);
    if (!profile.ok) return ok(fallback("agent_history_unavailable"));

    const controller = createSessionController({ row, profile: profile.value, deps: this.deps, historyOnly: true, fullReplay: true });
    try {
      const started = await controller.start(row.worktree_path, {
        kind: "load",
        acp_session_id: row.acp_session_id,
      }, loadSignal);
      if (loadSignal?.aborted) return err(acpError("acp_session_load_failed", "service.loadResumeHistory", "resume request was cancelled", kbblSid));
      if (!started.ok) return ok(fallback("agent_history_unavailable"));
      return ok({ kind: "transcript", sid: kbblSid, events: controller.snapshotEvents(), openTurns, expired: false, summary: null });
    } finally {
      await controller.closeChild();
    }
  }

  /**
   * History ownership for HTTP/SSE readers. A cold read may need an ACP child
   * for session/load, but that display-only child must not outlive its final
   * reader. Durable work and pre-existing live controllers are never owned by
   * this lease and are therefore never closed by it.
   */
  async acquireHistory(
    sid: string,
    consumerSignal?: AbortSignal,
  ): Promise<Result<HistoryLease, AcpError>> {
    const kbblSid = sid as KbblSessionId;
    let coldLoad = this.coldHistoryLoads.get(kbblSid) ?? null;
    if (coldLoad === null && this.deps.controllers.getLive(kbblSid) === null) {
      coldLoad = new AbortController();
      this.coldHistoryLoads.set(kbblSid, coldLoad);
    }
    this.historyConsumers.set(
      kbblSid,
      (this.historyConsumers.get(kbblSid) ?? 0) + 1,
    );

    let isReleased = false;
    const release = async () => {
      if (isReleased) return;
      isReleased = true;
      consumerSignal?.removeEventListener("abort", releaseOnAbort);
      await this.releaseHistoryConsumer(kbblSid, coldLoad);
    };
    const releaseOnAbort = () => {
      void release().catch((error: unknown) => {
        console.error(`[acp] sid=${kbblSid} history release failed`, error);
      });
    };
    consumerSignal?.addEventListener("abort", releaseOnAbort, { once: true });
    if (consumerSignal?.aborted) releaseOnAbort();

    const history = await this.loadHistory(sid, coldLoad?.signal);
    if (!history.ok) {
      await release();
      return history;
    }

    return ok({
      history: history.value,
      release,
    });
  }

  async captureSummary(controller: AcpSessionController): Promise<void> {
    if (this.deps.store.getSessionSummary(controller.sid)) return;
    if (controller.isPromptActive) return;
    const generated = await generateSessionSummary({
      session_id: controller.sid,
      events: controller.snapshotEvents(),
      produced_at: new Date().toISOString(),
    }, this.summaryGenerators);
    if (!generated.ok) {
      const detail = generated.error.map((failure) => `${failure.method}: ${failure.detail}`).join("; ");
      console.warn(`[acp] sid=${controller.sid} terminal summary unavailable: ${detail || "no generators configured"}`);
      return;
    }
    try {
      this.deps.store.putSessionSummary(generated.value);
    } catch (error) {
      console.error(`[acp] sid=${controller.sid} terminal summary persistence failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Capture a terminal fallback without registering a live controller or
   * dispatching durable input. This is the cold counterpart to
   * `captureSummary`: fencing records ownership first, then this display-only
   * load runs before the session row is finalized.
   */
  async captureColdSummary(row: AcpSessionRow): Promise<void> {
    if (this.deps.store.getSessionSummary(row.sid)) return;
    await this.loadTerminalHistory(row);
  }

  /**
   * Terminal history is display-only: replay through a private controller so
   * it cannot dispatch accepted work, reapply config, or reactivate the row.
   */
  private async loadTerminalHistory(
    row: AcpSessionRow,
    loadSignal?: AbortSignal,
  ): Promise<Result<UiSessionHistory, AcpError>> {
    const openTurns = this.deps.store.listOpenTurns(row.sid).map(turnToOpenTurn);
    const fallback = (reason: "missing_acp_session_id" | "agent_history_unavailable"): Result<UiSessionHistory, AcpError> => {
      const summary = this.deps.store.getSessionSummary(row.sid);
      return summary
        ? ok({ kind: "summary", sid: row.sid, events: [], openTurns, expired: true, summary })
        : ok({ kind: "unavailable", sid: row.sid, events: [], openTurns, expired: true, summary: null, reason });
    };
    if (row.acp_session_id === null) return fallback("missing_acp_session_id");
    const profile = resolveProfile(this.deps.profiles, row.agent_profile);
    if (!profile.ok) return fallback("agent_history_unavailable");

    const controller = createSessionController({ row, profile: profile.value, deps: this.deps, historyOnly: true });
    const started = await controller.start(row.worktree_path, {
      kind: "load",
      acp_session_id: row.acp_session_id,
    }, loadSignal);
    if (!started.ok) {
      await controller.closeChild();
      return fallback("agent_history_unavailable");
    }
    const events = controller.snapshotEvents();
    await this.captureSummary(controller);
    await controller.closeChild();
    return ok({
      kind: "transcript",
      sid: row.sid,
      events,
      openTurns,
      expired: false,
      summary: null,
    });
  }

  private async releaseHistoryConsumer(
    sid: KbblSessionId,
    coldLoad: AbortController | null,
  ): Promise<void> {
    const remaining = Math.max(0, (this.historyConsumers.get(sid) ?? 1) - 1);
    if (remaining > 0) {
      this.historyConsumers.set(sid, remaining);
      return;
    }
    this.historyConsumers.delete(sid);
    if (coldLoad === null) return;
    const controller = this.deps.controllers.getLive(sid);
    const hasDurableWork =
      (controller?.isPromptActive ?? false) ||
      this.deps.store.listAcceptedTurns(sid).length > 0;
    if (hasDurableWork || (controller?.hasSubscribers ?? false)) {
      // The display-only child has acquired a real owner. Detach it from
      // history lifecycle without aborting the active/queued work.
      if (this.coldHistoryLoads.get(sid) === coldLoad) {
        this.coldHistoryLoads.delete(sid);
      }
      return;
    }
    if (controller) {
      if (this.coldHistoryLoads.get(sid) === coldLoad) {
        this.coldHistoryLoads.delete(sid);
      }
      await controller.closeChild();
      return;
    }
    if (this.coldHistoryLoads.get(sid) === coldLoad) {
      this.coldHistoryLoads.delete(sid);
      coldLoad.abort();
    }
  }
}

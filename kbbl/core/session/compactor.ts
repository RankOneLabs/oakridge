// Compactor — schedules /compact firings based on session-token
// pressure and turn quiescence. Pure state machine + clock; the
// onFire callback is what actually runs runCompact.
//
// Wiring: SessionManager constructs one Compactor per Session in
// create() and calls session.attachCompactor(c). The CC classifier
// observes terminal `result` events and forwards them via
// observeAssistantTurn. Session forwards observeUserMessage,
// observePendingApprovalChange, and observeSessionEnded from its own
// hooks. The clock-based t_warm cancellation is driven by an internal
// setTimeout the class manages.
//
// The state machine has three states: idle, scheduled, firing.
//   idle      — no fire pending; observe* may transition to scheduled.
//   scheduled — a setTimeout is queued; cancellable by user/approval/
//               session-end events; fires transitions to firing.
//   firing    — onFire callback is in flight; observe* events are
//               recorded but no new schedule is created until
//               recordSuccess / recordFailure clears.

import type { KbblConfig } from "../config";

export type CompactReason =
  | { kind: "soft_threshold_window" }
  | { kind: "subagent_return_window" }
  | { kind: "hard_threshold_force" }
  | { kind: "manual" };

export type CancelReason =
  | "user_message"
  | "tool_use_start"
  | "approval_pending"
  | "window_expired"
  | "session_ended";

export interface CompactorCallbacks {
  onScheduled: (
    fireAt: Date,
    reason: CompactReason,
    sessionTokens: number,
  ) => void;
  onCancelled: (reason: CancelReason) => void;
  // sessionTokens is the token pressure recorded when the schedule was
  // created (or 0 for forceFire/manual where there is no recorded
  // pressure). Threaded through so compact_fired can report the same
  // tokens that triggered the compaction.
  onFire: (reason: CompactReason, sessionTokens: number) => Promise<void>;
}

interface ScheduledState {
  reason: CompactReason;
  fireAt: Date;
  sessionTokens: number;
  windowStartedAt: Date;
  timer: ReturnType<typeof setTimeout>;
  warmCapTimer: ReturnType<typeof setTimeout> | null;
}

export class Compactor {
  private readonly config: KbblConfig["compact"];
  private readonly callbacks: CompactorCallbacks;
  private readonly clock: () => Date;

  private state: "idle" | "scheduled" | "firing" = "idle";
  private scheduled: ScheduledState | null = null;
  private consecutiveFailureCount = 0;
  private pendingApprovalCount = 0;
  private disposed = false;

  constructor(
    config: KbblConfig["compact"],
    callbacks: CompactorCallbacks,
    clock?: () => Date,
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.clock = clock ?? (() => new Date());
  }

  observeAssistantTurn(input: {
    stop_reason: string;
    session_tokens: number;
    was_subagent_synthesis: boolean;
  }): void {
    if (this.disposed) return;
    if (input.stop_reason !== "end_turn") return;
    if (this.state !== "idle") return;

    const tokens = input.session_tokens;
    const cfg = this.config;

    const force =
      this.consecutiveFailureCount >=
      cfg.max_consecutive_failures_before_force;
    if (tokens >= cfg.hard_threshold_tokens || force) {
      this.schedule({ kind: "hard_threshold_force" }, 0, tokens);
      return;
    }

    if (tokens > cfg.soft_threshold_tokens && this.pendingApprovalCount === 0) {
      const delaySec = input.was_subagent_synthesis
        ? cfg.t_quiet_after_subagent_seconds
        : cfg.t_quiet_seconds;
      const reason: CompactReason = input.was_subagent_synthesis
        ? { kind: "subagent_return_window" }
        : { kind: "soft_threshold_window" };
      this.schedule(reason, delaySec * 1000, tokens);
      return;
    }
  }

  observeUserMessage(): void {
    if (this.state === "scheduled") this.cancel("user_message");
  }

  observeToolUseStart(): void {
    if (this.state === "scheduled") this.cancel("tool_use_start");
  }

  observeToolUseEnd(): void {
    // No-op in v0 (mirror of observeToolUseStart's punt). Kept on the
    // API surface so a future signal-forwarding edit doesn't have to
    // change the class.
  }

  observeSubagentReturn(): void {
    // No-op in v0 — subagent detection is punted; the
    // was_subagent_synthesis flag on observeAssistantTurn is always
    // false. Kept on the API surface.
  }

  observePendingApprovalChange(count: number): void {
    this.pendingApprovalCount = count;
    if (count > 0 && this.state === "scheduled") {
      // Don't cancel hard-threshold fires — those are forced regardless
      // of approval pressure (the compactor's job in that state is to
      // recover from a session that's already too big).
      if (this.scheduled?.reason.kind !== "hard_threshold_force") {
        this.cancel("approval_pending");
      }
    }
  }

  observeSessionEnded(): void {
    if (this.state === "scheduled") this.cancel("session_ended");
  }

  async forceFire(reason: CompactReason): Promise<void> {
    if (this.disposed) return;
    if (this.state === "firing") return;
    if (this.state === "scheduled") this.clearScheduled();
    await this.fire(reason, 0);
  }

  getScheduledFireAt(): Date | null {
    return this.scheduled?.fireAt ?? null;
  }

  recordFailure(): void {
    this.consecutiveFailureCount += 1;
    this.state = "idle";
  }

  recordSuccess(): void {
    this.consecutiveFailureCount = 0;
    this.state = "idle";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.state === "scheduled") this.clearScheduled();
  }

  private schedule(
    reason: CompactReason,
    delayMs: number,
    sessionTokens: number,
  ): void {
    const now = this.clock();
    const fireAt = new Date(now.getTime() + delayMs);
    const timer = setTimeout(() => {
      void this.fire(reason, sessionTokens);
    }, delayMs);

    let warmCapTimer: ReturnType<typeof setTimeout> | null = null;
    if (reason.kind !== "hard_threshold_force" && delayMs > 0) {
      warmCapTimer = setTimeout(
        () => {
          if (this.state === "scheduled") this.cancel("window_expired");
        },
        this.config.t_warm_seconds * 1000,
      );
    }

    this.scheduled = {
      reason,
      fireAt,
      sessionTokens,
      windowStartedAt: now,
      timer,
      warmCapTimer,
    };
    this.state = "scheduled";
    try {
      this.callbacks.onScheduled(fireAt, reason, sessionTokens);
    } catch (err) {
      console.error(
        `kbbl: compactor onScheduled callback failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private cancel(reason: CancelReason): void {
    if (this.state !== "scheduled" || this.scheduled === null) return;
    this.clearScheduled();
    try {
      this.callbacks.onCancelled(reason);
    } catch (err) {
      console.error(
        `kbbl: compactor onCancelled callback failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private clearScheduled(): void {
    if (this.scheduled === null) return;
    clearTimeout(this.scheduled.timer);
    if (this.scheduled.warmCapTimer !== null) {
      clearTimeout(this.scheduled.warmCapTimer);
    }
    this.scheduled = null;
    this.state = "idle";
  }

  private async fire(
    reason: CompactReason,
    sessionTokens: number,
  ): Promise<void> {
    if (this.disposed) return;
    if (this.state !== "scheduled" && this.state !== "idle") return;
    // Clear scheduled state BEFORE entering firing so a re-entry
    // (e.g. forceFire while a soft-window timer is pending) doesn't
    // double-clear or leak the timer.
    if (this.scheduled !== null) this.clearScheduled();
    this.state = "firing";
    try {
      await this.callbacks.onFire(reason, sessionTokens);
    } catch (err) {
      console.error(
        `kbbl: compactor onFire threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.recordFailure();
      return;
    }
    // onFire is expected to call recordSuccess / recordFailure on
    // SessionManager's side — we don't auto-clear state here.
    // Belt-and-suspenders: if onFire returned without either having
    // been called (state still "firing"), force back to idle so the
    // next observe* can schedule.
    if (this.state === "firing") this.state = "idle";
  }
}

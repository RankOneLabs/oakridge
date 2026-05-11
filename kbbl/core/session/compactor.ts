// Compactor — emits compact suggestions based on session-token pressure
// and fires /compact when explicitly requested. Pure state machine; the
// onFire callback is what actually runs runCompact.
//
// Wiring: SessionManager constructs one Compactor per Session in
// create() and calls session.attachCompactor(c). The CC classifier
// observes terminal `result` events and forwards them via
// observeAssistantTurn.
//
// The state machine has two states: idle and firing.
//   idle    — no fire in flight; observeAssistantTurn calls onSuggested
//             when thresholds are crossed (no auto-fire).
//   firing  — onFire callback is in flight; observe* events are
//             recorded but no suggestion is emitted until
//             recordSuccess / recordFailure clears.

import type { KbblConfig } from "../config";

export type CompactReason =
  | { kind: "soft_threshold_window" }
  | { kind: "subagent_return_window" }
  | { kind: "hard_threshold_force" }
  | { kind: "manual" };

export interface CompactorCallbacks {
  onSuggested: (reason: CompactReason, sessionTokens: number) => void;
  // sessionTokens is 0 for forceFire/manual (no recorded pressure).
  // Threaded through so compact_fired can report the tokens that
  // triggered the compaction on the auto path.
  onFire: (reason: CompactReason, sessionTokens: number) => Promise<void>;
}

export class Compactor {
  private readonly config: KbblConfig["compact"];
  private readonly callbacks: CompactorCallbacks;

  private state: "idle" | "firing" = "idle";
  private consecutiveFailureCount = 0;
  private pendingApprovalCount = 0;
  private disposed = false;

  constructor(
    config: KbblConfig["compact"],
    callbacks: CompactorCallbacks,
  ) {
    this.config = config;
    this.callbacks = callbacks;
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
      try {
        this.callbacks.onSuggested({ kind: "hard_threshold_force" }, tokens);
      } catch (err) {
        console.error(
          `kbbl: compactor onSuggested callback failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    if (tokens > cfg.soft_threshold_tokens && this.pendingApprovalCount === 0) {
      const reason: CompactReason = input.was_subagent_synthesis
        ? { kind: "subagent_return_window" }
        : { kind: "soft_threshold_window" };
      try {
        this.callbacks.onSuggested(reason, tokens);
      } catch (err) {
        console.error(
          `kbbl: compactor onSuggested callback failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }
  }

  observeUserMessage(): void {
    // No-op — no scheduled timers to cancel. Kept on the API surface
    // so callers don't have to change if scheduling is reintroduced.
  }

  observeToolUseStart(): void {
    // No-op in v0. Kept on the API surface.
  }

  observeToolUseEnd(): void {
    // No-op in v0. Kept on the API surface.
  }

  observeSubagentReturn(): void {
    // No-op in v0 — subagent detection is punted. Kept on the API surface.
  }

  observePendingApprovalChange(count: number): void {
    this.pendingApprovalCount = count;
  }

  observeSessionEnded(): void {
    // No-op — no scheduled timers to cancel. Kept on the API surface.
  }

  async forceFire(reason: CompactReason): Promise<void> {
    if (this.disposed) return;
    if (this.state === "firing") return;
    await this.fire(reason, 0);
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
    this.disposed = true;
  }

  private async fire(
    reason: CompactReason,
    sessionTokens: number,
  ): Promise<void> {
    if (this.disposed) return;
    if (this.state !== "idle") return;
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
    // onFire is expected to call recordSuccess / recordFailure.
    // Belt-and-suspenders: if neither was called, reset to idle.
    if (this.state === "firing") this.state = "idle";
  }
}

import { describe, expect, test } from "bun:test";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { Compactor, type CancelReason, type CompactReason } from "./compactor";

function buildCompact(): KbblConfig["compact"] {
  return KbblConfigSchema.parse({}).compact;
}

interface ObservedCalls {
  scheduled: Array<{
    fireAt: Date;
    reason: CompactReason;
    sessionTokens: number;
  }>;
  cancelled: CancelReason[];
  fired: CompactReason[];
}

function makeCompactor(opts?: {
  config?: Partial<KbblConfig["compact"]>;
  onFireImpl?: (reason: CompactReason) => Promise<void>;
  clock?: () => Date;
}) {
  const base = buildCompact();
  const config = { ...base, ...opts?.config };
  const calls: ObservedCalls = {
    scheduled: [],
    cancelled: [],
    fired: [],
  };
  const c = new Compactor(
    config,
    {
      onScheduled: (fireAt, reason, sessionTokens) => {
        calls.scheduled.push({ fireAt, reason, sessionTokens });
      },
      onCancelled: (reason) => calls.cancelled.push(reason),
      onFire: async (reason) => {
        calls.fired.push(reason);
        if (opts?.onFireImpl) await opts.onFireImpl(reason);
      },
    },
    opts?.clock ?? (() => new Date(0)),
  );
  return { compactor: c, calls };
}

describe("Compactor scheduling", () => {
  test("below soft threshold: no schedule", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 1000,
      was_subagent_synthesis: false,
    });
    expect(calls.scheduled.length).toBe(0);
    expect(compactor.getScheduledFireAt()).toBeNull();
    compactor.dispose();
  });

  test("soft threshold crossed: schedules with t_quiet delay", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 35000,
      was_subagent_synthesis: false,
    });
    expect(calls.scheduled.length).toBe(1);
    expect(calls.scheduled[0]!.reason.kind).toBe("soft_threshold_window");
    const delay =
      calls.scheduled[0]!.fireAt.getTime() - new Date(0).getTime();
    expect(delay).toBe(30 * 1000);
    compactor.dispose();
  });

  test("hard threshold force-fires immediately (zero delay)", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 80000,
      was_subagent_synthesis: false,
    });
    expect(calls.scheduled.length).toBe(1);
    expect(calls.scheduled[0]!.reason.kind).toBe("hard_threshold_force");
    const delay =
      calls.scheduled[0]!.fireAt.getTime() - new Date(0).getTime();
    expect(delay).toBe(0);
    compactor.dispose();
  });

  test("subagent synthesis uses t_quiet_after_subagent", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 35000,
      was_subagent_synthesis: true,
    });
    expect(calls.scheduled.length).toBe(1);
    expect(calls.scheduled[0]!.reason.kind).toBe("subagent_return_window");
    const delay =
      calls.scheduled[0]!.fireAt.getTime() - new Date(0).getTime();
    expect(delay).toBe(15 * 1000);
    compactor.dispose();
  });

  test("pending approval at soft-threshold time: no schedule", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observePendingApprovalChange(1);
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 35000,
      was_subagent_synthesis: false,
    });
    expect(calls.scheduled.length).toBe(0);
    compactor.dispose();
  });

  test("hard threshold ignores pending approvals", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observePendingApprovalChange(1);
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 80000,
      was_subagent_synthesis: false,
    });
    expect(calls.scheduled.length).toBe(1);
    expect(calls.scheduled[0]!.reason.kind).toBe("hard_threshold_force");
    compactor.dispose();
  });
});

describe("Compactor cancellation", () => {
  test("user message cancels scheduled fire", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 35000,
      was_subagent_synthesis: false,
    });
    compactor.observeUserMessage();
    expect(calls.cancelled).toEqual(["user_message"]);
    expect(compactor.getScheduledFireAt()).toBeNull();
    compactor.dispose();
  });

  test("pending approval cancels soft-window fire (not hard-threshold)", () => {
    {
      const { compactor, calls } = makeCompactor();
      compactor.observeAssistantTurn({
        stop_reason: "end_turn",
        session_tokens: 35000,
        was_subagent_synthesis: false,
      });
      compactor.observePendingApprovalChange(1);
      expect(calls.cancelled).toEqual(["approval_pending"]);
      compactor.dispose();
    }
    {
      const { compactor, calls } = makeCompactor();
      compactor.observeAssistantTurn({
        stop_reason: "end_turn",
        session_tokens: 80000,
        was_subagent_synthesis: false,
      });
      compactor.observePendingApprovalChange(1);
      expect(calls.cancelled).toEqual([]);
      compactor.dispose();
    }
  });

  test("session ended cancels scheduled fire", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 35000,
      was_subagent_synthesis: false,
    });
    compactor.observeSessionEnded();
    expect(calls.cancelled).toEqual(["session_ended"]);
    compactor.dispose();
  });

  // slow: 5s real-time. The t_warm cap timer is wall-clock driven via
  // setTimeout — there's no clean way to verify it fires without
  // actually waiting. Configure the cap to 5s and the quiet window to
  // 10s so the cap fires before the scheduled fire would.
  test("t_warm cap cancels stale schedule", async () => {
    const { compactor, calls } = makeCompactor({
      config: { t_warm_seconds: 5, t_quiet_seconds: 10 },
    });
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 35000,
      was_subagent_synthesis: false,
    });
    expect(calls.scheduled.length).toBe(1);
    await Bun.sleep(5100);
    expect(calls.cancelled).toEqual(["window_expired"]);
    expect(calls.fired.length).toBe(0);
    compactor.dispose();
  }, 10000);
});

describe("Compactor force-after-failures", () => {
  test("recordFailure increments failure count; max+1 forces next fire", () => {
    const { compactor, calls } = makeCompactor({
      config: { max_consecutive_failures_before_force: 2 },
    });
    compactor.recordFailure();
    compactor.recordFailure();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 1000,
      was_subagent_synthesis: false,
    });
    expect(calls.scheduled.length).toBe(1);
    expect(calls.scheduled[0]!.reason.kind).toBe("hard_threshold_force");
    compactor.dispose();
  });

  test("recordSuccess resets failure count", () => {
    const { compactor, calls } = makeCompactor({
      config: { max_consecutive_failures_before_force: 2 },
    });
    compactor.recordFailure();
    compactor.recordFailure();
    compactor.recordSuccess();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 1000,
      was_subagent_synthesis: false,
    });
    expect(calls.scheduled.length).toBe(0);
    compactor.dispose();
  });
});

import { describe, expect, test } from "bun:test";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { Compactor, type CancelReason, type CompactReason } from "./compactor";

function buildCompact(): KbblConfig["compact"] {
  return KbblConfigSchema.parse({}).compact;
}

interface ObservedCalls {
  suggested: Array<{ reason: CompactReason; sessionTokens: number }>;
  scheduled: Array<{
    fireAt: Date;
    reason: CompactReason;
    sessionTokens: number;
  }>;
  cancelled: CancelReason[];
  fired: Array<{ reason: CompactReason; sessionTokens: number }>;
}

function makeCompactor(opts?: {
  config?: Partial<KbblConfig["compact"]>;
  onFireImpl?: (reason: CompactReason) => Promise<void>;
  clock?: () => Date;
}) {
  const base = buildCompact();
  const config = { ...base, ...opts?.config };
  const calls: ObservedCalls = {
    suggested: [],
    scheduled: [],
    cancelled: [],
    fired: [],
  };
  const c = new Compactor(
    config,
    {
      onSuggested: (reason, sessionTokens) => {
        calls.suggested.push({ reason, sessionTokens });
      },
      onScheduled: (fireAt, reason, sessionTokens) => {
        calls.scheduled.push({ fireAt, reason, sessionTokens });
      },
      onCancelled: (reason) => calls.cancelled.push(reason),
      onFire: async (reason, sessionTokens) => {
        calls.fired.push({ reason, sessionTokens });
        if (opts?.onFireImpl) await opts.onFireImpl(reason);
      },
    },
    opts?.clock ?? (() => new Date(0)),
  );
  return { compactor: c, calls };
}

describe("Compactor scheduling", () => {
  test("below soft threshold: no schedule, no suggestion", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 1000,
      was_subagent_synthesis: false,
    });
    expect(calls.suggested.length).toBe(0);
    expect(calls.scheduled.length).toBe(0);
    expect(compactor.getScheduledFireAt()).toBeNull();
    compactor.dispose();
  });

  test("soft threshold crossed: calls onSuggested, not onScheduled, not onFire", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 35000,
      was_subagent_synthesis: false,
    });
    expect(calls.suggested.length).toBe(1);
    expect(calls.suggested[0]!.reason.kind).toBe("soft_threshold_window");
    expect(calls.suggested[0]!.sessionTokens).toBe(35000);
    expect(calls.scheduled.length).toBe(0);
    expect(calls.fired.length).toBe(0);
    expect(compactor.getScheduledFireAt()).toBeNull();
    compactor.dispose();
  });

  test("hard threshold crossed: calls onSuggested, not schedule or fire", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 80000,
      was_subagent_synthesis: false,
    });
    expect(calls.suggested.length).toBe(1);
    expect(calls.suggested[0]!.reason.kind).toBe("hard_threshold_force");
    expect(calls.suggested[0]!.sessionTokens).toBe(80000);
    expect(calls.scheduled.length).toBe(0);
    expect(calls.fired.length).toBe(0);
    expect(compactor.getScheduledFireAt()).toBeNull();
    compactor.dispose();
  });

  test("subagent synthesis: calls onSuggested with subagent_return_window reason", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 35000,
      was_subagent_synthesis: true,
    });
    expect(calls.suggested.length).toBe(1);
    expect(calls.suggested[0]!.reason.kind).toBe("subagent_return_window");
    expect(calls.suggested[0]!.sessionTokens).toBe(35000);
    expect(calls.scheduled.length).toBe(0);
    expect(calls.fired.length).toBe(0);
    compactor.dispose();
  });

  test("pending approval at soft-threshold time: no schedule, no suggestion", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observePendingApprovalChange(1);
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 35000,
      was_subagent_synthesis: false,
    });
    expect(calls.suggested.length).toBe(0);
    expect(calls.scheduled.length).toBe(0);
    compactor.dispose();
  });

  test("hard threshold suggestion fires even with pending approvals", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observePendingApprovalChange(1);
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 80000,
      was_subagent_synthesis: false,
    });
    expect(calls.suggested.length).toBe(1);
    expect(calls.suggested[0]!.reason.kind).toBe("hard_threshold_force");
    expect(calls.scheduled.length).toBe(0);
    compactor.dispose();
  });
});

describe("Compactor cancellation", () => {
  test("user message after hard-threshold suggestion: no cancel, state stays idle", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 80000,
      was_subagent_synthesis: false,
    });
    compactor.observeUserMessage();
    expect(calls.cancelled).toEqual([]);
    expect(calls.suggested.length).toBe(1);
    expect(compactor.getScheduledFireAt()).toBeNull();
    compactor.dispose();
  });

  test("pending approval after hard-threshold suggestion: no cancel", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 80000,
      was_subagent_synthesis: false,
    });
    compactor.observePendingApprovalChange(1);
    expect(calls.cancelled).toEqual([]);
    expect(calls.suggested.length).toBe(1);
    compactor.dispose();
  });

  test("session ended after hard-threshold suggestion: no cancel", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 80000,
      was_subagent_synthesis: false,
    });
    compactor.observeSessionEnded();
    expect(calls.cancelled).toEqual([]);
    expect(calls.suggested.length).toBe(1);
    compactor.dispose();
  });
});

describe("Compactor onFire sessionTokens threading", () => {
  test("hard-threshold suggestion passes the recorded tokens to onSuggested", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 80000,
      was_subagent_synthesis: false,
    });
    expect(calls.suggested.length).toBe(1);
    expect(calls.suggested[0]!.sessionTokens).toBe(80000);
    expect(calls.fired.length).toBe(0);
    compactor.dispose();
  });

  test("forceFire passes 0 since no schedule recorded the pressure", async () => {
    const { compactor, calls } = makeCompactor();
    await compactor.forceFire({ kind: "manual" });
    expect(calls.fired.length).toBe(1);
    expect(calls.fired[0]!.sessionTokens).toBe(0);
    compactor.dispose();
  });
});

describe("Compactor force-after-failures", () => {
  test("recordFailure increments failure count; max+1 forces a suggestion", () => {
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
    expect(calls.suggested.length).toBe(1);
    expect(calls.suggested[0]!.reason.kind).toBe("hard_threshold_force");
    expect(calls.scheduled.length).toBe(0);
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

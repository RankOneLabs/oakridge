import { describe, expect, test } from "bun:test";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { Compactor, type CompactReason } from "./compactor";

function buildCompact(): KbblConfig["compact"] {
  return KbblConfigSchema.parse({}).compact;
}

interface ObservedCalls {
  suggested: Array<{ reason: CompactReason; sessionTokens: number }>;
  fired: Array<{ reason: CompactReason; sessionTokens: number }>;
}

function makeCompactor(opts?: {
  config?: Partial<KbblConfig["compact"]>;
  onFireImpl?: (reason: CompactReason) => Promise<void>;
}) {
  const base = buildCompact();
  const config = { ...base, ...opts?.config };
  const calls: ObservedCalls = {
    suggested: [],
    fired: [],
  };
  const c = new Compactor(config, {
    onSuggested: (reason, sessionTokens) => {
      calls.suggested.push({ reason, sessionTokens });
    },
    onFire: async (reason, sessionTokens) => {
      calls.fired.push({ reason, sessionTokens });
      if (opts?.onFireImpl) await opts.onFireImpl(reason);
    },
  });
  return { compactor: c, calls };
}

describe("Compactor scheduling", () => {
  test("below soft threshold: no suggestion, no fire", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 1000,
      was_subagent_synthesis: false,
    });
    expect(calls.suggested.length).toBe(0);
    expect(calls.fired.length).toBe(0);
    compactor.dispose();
  });

  test("soft threshold crossed: calls onSuggested, not onFire", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 35000,
      was_subagent_synthesis: false,
    });
    expect(calls.suggested.length).toBe(1);
    expect(calls.suggested[0]!.reason.kind).toBe("soft_threshold_window");
    expect(calls.suggested[0]!.sessionTokens).toBe(35000);
    expect(calls.fired.length).toBe(0);
    compactor.dispose();
  });

  test("hard threshold crossed: calls onSuggested, not onFire", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 80000,
      was_subagent_synthesis: false,
    });
    expect(calls.suggested.length).toBe(1);
    expect(calls.suggested[0]!.reason.kind).toBe("hard_threshold_force");
    expect(calls.suggested[0]!.sessionTokens).toBe(80000);
    expect(calls.fired.length).toBe(0);
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
    expect(calls.fired.length).toBe(0);
    compactor.dispose();
  });

  test("pending approval at soft-threshold time: no suggestion", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observePendingApprovalChange(1);
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 35000,
      was_subagent_synthesis: false,
    });
    expect(calls.suggested.length).toBe(0);
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
    compactor.dispose();
  });
});

describe("Compactor no-ops", () => {
  test("user message, session ended, tool events are no-ops (no timers to cancel)", () => {
    const { compactor, calls } = makeCompactor();
    compactor.observeAssistantTurn({
      stop_reason: "end_turn",
      session_tokens: 80000,
      was_subagent_synthesis: false,
    });
    compactor.observeUserMessage();
    compactor.observeToolUseStart();
    compactor.observeSessionEnded();
    // Suggestion already fired; no additional effects from the no-op observers.
    expect(calls.suggested.length).toBe(1);
    expect(calls.fired.length).toBe(0);
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

  test("forceFire passes 0 tokens to onFire", async () => {
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
    expect(calls.suggested.length).toBe(0);
    compactor.dispose();
  });
});

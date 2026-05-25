import { describe, test, expect } from "bun:test";
import {
  normalizeAgentMessageDelta,
  normalizeAgentMessageCompleted,
  normalizeTurnCompleted,
  extractTurnUsage,
  normalizeNotification,
  CODEX_NON_PERSISTED_EVENT_TYPES,
} from "./events";
import type {
  ItemAgentMessageDeltaParams,
  TurnCompletedParams,
  ThreadTokenUsageUpdatedParams,
} from "./protocol/generated/types";

describe("normalizeAgentMessageDelta", () => {
  test("produces correct type and fields", () => {
    const params: ItemAgentMessageDeltaParams = {
      threadId: "t1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "hello",
    };
    const evt = normalizeAgentMessageDelta(params);
    expect(evt.type).toBe("assistant_delta");
    expect(evt.payload.type).toBe("assistant_delta");
    expect(evt.payload.threadId).toBe("t1");
    expect(evt.payload.turnId).toBe("turn-1");
    expect(evt.payload.itemId).toBe("item-1");
    expect(evt.payload.delta).toBe("hello");
  });
});

describe("normalizeAgentMessageCompleted", () => {
  test("returns assistant event for agentMessage item", () => {
    const item = { type: "agentMessage", id: "msg-1", text: "pong" };
    const evt = normalizeAgentMessageCompleted(item, "t1", "turn-1");
    expect(evt).not.toBeNull();
    expect(evt!.type).toBe("assistant");
    expect((evt!.payload.message as { content: string }).content).toBe("pong");
  });

  test("returns null for non-agentMessage item", () => {
    const item = { type: "userMessage", id: "msg-2" };
    expect(normalizeAgentMessageCompleted(item, "t1", "turn-1")).toBeNull();
  });

  test("returns null for null item", () => {
    expect(normalizeAgentMessageCompleted(null, "t1", "turn-1")).toBeNull();
  });

  test("returns null for non-object item", () => {
    expect(normalizeAgentMessageCompleted("string", "t1", "turn-1")).toBeNull();
  });

  test("handles missing text field", () => {
    const item = { type: "agentMessage" };
    const evt = normalizeAgentMessageCompleted(item, "t1", "turn-1");
    expect(evt).not.toBeNull();
    expect((evt!.payload.message as { content: string }).content).toBe("");
  });
});

describe("normalizeTurnCompleted", () => {
  function makeTurn(status: string): TurnCompletedParams {
    return {
      threadId: "t1",
      turn: {
        id: "turn-1",
        items: [],
        itemsView: "full",
        status: status as "completed" | "interrupted" | "inProgress" | "failed",
        error: null,
        startedAt: 1700000000,
        completedAt: 1700000001,
        durationMs: 1000,
      },
    };
  }

  test("maps completed status → success subtype", () => {
    const evt = normalizeTurnCompleted(makeTurn("completed"));
    expect(evt.type).toBe("result");
    expect(evt.payload.subtype).toBe("success");
  });

  test("maps interrupted status → interrupted subtype", () => {
    const evt = normalizeTurnCompleted(makeTurn("interrupted"));
    expect(evt.type).toBe("result");
    expect(evt.payload.subtype).toBe("interrupted");
  });

  test("maps failed status → success subtype (not interrupted)", () => {
    const evt = normalizeTurnCompleted(makeTurn("failed"));
    expect(evt.payload.subtype).toBe("success");
  });

  test("includes threadId in payload", () => {
    const evt = normalizeTurnCompleted(makeTurn("completed"));
    expect(evt.payload.threadId).toBe("t1");
  });
});

describe("extractTurnUsage", () => {
  const params: ThreadTokenUsageUpdatedParams = {
    threadId: "t1",
    turnId: "turn-1",
    tokenUsage: {
      total: {
        totalTokens: 1000,
        inputTokens: 800,
        cachedInputTokens: 400,
        outputTokens: 200,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 100,
        inputTokens: 80,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 200000,
    },
  };

  test("extracts from last bucket, not total", () => {
    const usage = extractTurnUsage(params);
    expect(usage.inputTokens).toBe(80);
    expect(usage.outputTokens).toBe(20);
    expect(usage.cachedInputTokens).toBe(40);
  });

  test("does not use total bucket values", () => {
    const usage = extractTurnUsage(params);
    expect(usage.inputTokens).not.toBe(800);
    expect(usage.outputTokens).not.toBe(200);
  });
});

describe("normalizeNotification", () => {
  test("routes item/agentMessage/delta", () => {
    const evt = normalizeNotification("item/agentMessage/delta", {
      threadId: "t1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "word",
    });
    expect(evt?.type).toBe("assistant_delta");
  });

  test("routes turn/completed", () => {
    const evt = normalizeNotification("turn/completed", {
      threadId: "t1",
      turn: { id: "turn-1", items: [], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null },
    });
    expect(evt?.type).toBe("result");
  });

  test("routes item/completed for agentMessage", () => {
    const evt = normalizeNotification("item/completed", {
      item: { type: "agentMessage", text: "hi" },
      threadId: "t1",
      turnId: "turn-1",
    });
    expect(evt?.type).toBe("assistant");
  });

  test("returns null for item/completed with non-agentMessage", () => {
    const evt = normalizeNotification("item/completed", {
      item: { type: "commandExecution" },
      threadId: "t1",
      turnId: "turn-1",
    });
    expect(evt).toBeNull();
  });

  test("returns null for unknown methods", () => {
    expect(normalizeNotification("thread/status/changed", {})).toBeNull();
    expect(normalizeNotification("account/rateLimits/updated", {})).toBeNull();
    expect(normalizeNotification("configWarning", {})).toBeNull();
  });
});

describe("CODEX_NON_PERSISTED_EVENT_TYPES", () => {
  test("contains assistant_delta", () => {
    expect(CODEX_NON_PERSISTED_EVENT_TYPES.has("assistant_delta")).toBe(true);
  });

  test("contains codex_approval_server_request", () => {
    expect(CODEX_NON_PERSISTED_EVENT_TYPES.has("codex_approval_server_request")).toBe(true);
  });

  test("is a Set", () => {
    expect(CODEX_NON_PERSISTED_EVENT_TYPES instanceof Set).toBe(true);
  });
});

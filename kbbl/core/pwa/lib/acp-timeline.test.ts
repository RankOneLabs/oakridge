import { describe, expect, it } from "vitest";

import type { AcpUiEvent, TurnKey } from "../types";
import { groupConfigOptions, projectTimeline } from "./acp-timeline";

function agentChunk(id: string, text: string, streaming = true): AcpUiEvent {
  return {
    kind: "agent_message",
    id,
    content: [{ type: "text", text }],
    streaming,
    replayed: false,
  };
}

function userMessage(id: string, text: string): AcpUiEvent {
  return {
    kind: "user_message",
    id,
    content: [{ type: "text", text }],
    replayed: false,
  };
}

describe("projectTimeline chunk folding", () => {
  it("folds a consecutive run of same-id agent chunks into one bubble", () => {
    const projection = projectTimeline([
      agentChunk("m1", "Hello "),
      agentChunk("m1", "world"),
    ]);
    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]).toMatchObject({ kind: "agent", text: "Hello world" });
  });

  it("a tool call between chunks splits the run into two bubbles", () => {
    const projection = projectTimeline([
      agentChunk("m1", "before"),
      {
        kind: "tool_call",
        toolCallId: "t1",
        title: "Read file",
        status: "in_progress",
        content: null,
      },
      agentChunk("m1", "after"),
    ]);
    expect(projection.items.map((item) => item.kind)).toEqual([
      "agent",
      "tool",
      "agent",
    ]);
  });

  it("a different chunk id starts a new bubble", () => {
    const projection = projectTimeline([
      agentChunk("m1", "first"),
      agentChunk("m2", "second"),
    ]);
    expect(projection.items).toHaveLength(2);
  });

  it("thought chunks fold separately from agent text", () => {
    const projection = projectTimeline([
      { kind: "thought", id: "t", content: [{ type: "text", text: "hm " }], streaming: true, replayed: false },
      { kind: "thought", id: "t", content: [{ type: "text", text: "ok" }], streaming: false, replayed: false },
      agentChunk("m1", "answer"),
    ]);
    expect(projection.items).toHaveLength(2);
    expect(projection.items[0]).toMatchObject({
      kind: "thought",
      text: "hm ok",
      streaming: false,
    });
  });
});

describe("projectTimeline tool calls", () => {
  it("tool_call updates land on the original card in place", () => {
    const projection = projectTimeline([
      {
        kind: "tool_call",
        toolCallId: "t1",
        title: "Run tests",
        status: "in_progress",
        content: null,
      },
      agentChunk("m1", "meanwhile"),
      {
        kind: "tool_call",
        toolCallId: "t1",
        title: "",
        status: "completed",
        content: { exit: 0 },
      },
    ]);
    expect(projection.items).toHaveLength(2);
    expect(projection.items[0]).toMatchObject({
      kind: "tool",
      title: "Run tests",
      status: "completed",
      content: { exit: 0 },
    });
  });
});

describe("projectTimeline permissions", () => {
  const permission: AcpUiEvent = {
    kind: "permission",
    requestId: "perm-1",
    title: "Run bash?",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  };

  it("an unanswered permission is open", () => {
    const projection = projectTimeline([permission]);
    expect(projection.openPermissions).toHaveLength(1);
    expect(projection.items[0]).toMatchObject({
      kind: "permission",
      resolution: null,
    });
  });

  it("permission_resolved retires the card with its outcome", () => {
    const projection = projectTimeline([
      permission,
      {
        kind: "permission_resolved",
        requestId: "perm-1",
        outcome: "selected",
        optionId: "allow",
      },
    ]);
    expect(projection.openPermissions).toHaveLength(0);
    expect(projection.items[0]).toMatchObject({
      resolution: { outcome: "selected", optionId: "allow" },
    });
  });
});

describe("projectTimeline turn state and latest-wins folds", () => {
  const turnKey = "turn-1" as TurnKey;
  it("turnActive follows the last turn_state", () => {
    expect(
      projectTimeline([
        { kind: "turn_state", turnKey, state: "prompting" },
      ]).turnActive,
    ).toBe(true);
    expect(
      projectTimeline([
        { kind: "turn_state", turnKey, state: "prompting" },
        { kind: "turn_state", turnKey, state: "idle" },
      ]).turnActive,
    ).toBe(false);
  });

  it("cancelled/failed/unknown turns leave a visible note; idle does not", () => {
    const projection = projectTimeline([
      { kind: "turn_state", turnKey, state: "idle" },
      {
        kind: "turn_state",
        turnKey,
        state: "cancelled",
        stopReason: "cancelled",
      },
    ]);
    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]).toMatchObject({ kind: "turn_note", state: "cancelled" });
  });

  it("config, commands, and usage fold latest-wins outside the timeline", () => {
    const projection = projectTimeline([
      userMessage("u1", "hi"),
      {
        kind: "config_options",
        options: [
          { id: "model", name: "Model", category: "model", type: "select", value: "a", options: [] },
        ],
      },
      { kind: "commands", commands: [{ name: "compact", description: null }] },
      { kind: "usage", used: 100, size: 1000 },
      { kind: "usage", used: 200, size: 1000 },
    ]);
    expect(projection.items).toHaveLength(1);
    expect(projection.configOptions).toHaveLength(1);
    expect(projection.commands).toEqual([{ name: "compact", description: null }]);
    expect(projection.usage).toEqual({ used: 200, size: 1000, cost: null });
  });

  it("plan updates replace the single plan card in place", () => {
    const projection = projectTimeline([
      { kind: "plan", entries: [{ content: "a", status: "pending", priority: "medium" }] },
      userMessage("u1", "go"),
      { kind: "plan", entries: [{ content: "a", status: "completed", priority: "medium" }] },
    ]);
    const plans = projection.items.filter((item) => item.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      entries: [{ content: "a", status: "completed", priority: "medium" }],
    });
  });
});

describe("groupConfigOptions", () => {
  it("routes semantic categories to named slots and the rest to overflow", () => {
    const grouped = groupConfigOptions([
      { id: "m", name: "Model", category: "model", type: "select", value: "x", options: [] },
      { id: "t", name: "Thinking", category: "thought_level", type: "select", value: "y", options: [] },
      { id: "mode", name: "Mode", category: "mode", type: "select", value: "z", options: [] },
      { id: "other", name: "Verbose", category: null, type: "boolean", value: true, options: [] },
    ]);
    expect(grouped.model?.id).toBe("m");
    expect(grouped.thoughtLevel?.id).toBe("t");
    expect(grouped.mode?.id).toBe("mode");
    expect(grouped.overflow.map((option) => option.id)).toEqual(["other"]);
  });
});

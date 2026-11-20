import { expect, test } from "bun:test";
import { projectTimeline, type TimelineItem } from "../pwa/lib/acp-timeline";
import { createTranscriptBuffer, foldUpdate } from "./transcript-fold";
import { renderLegacyEvents, toWireEvent } from "./transcript-legacy-wire";
import { streamEpoch } from "./transcript-model";
import type { AcpUiEvent, TurnKey } from "./types";

const epoch = streamEpoch("legacy");
const turnKey = "operator:send" as TurnKey;

const user = {
  kind: "user_message", id: turnKey, content: [{ type: "text", text: "Run it" }], replayed: false,
} satisfies AcpUiEvent;
const agent = {
  kind: "agent_message", id: "m1", content: [{ type: "text", text: "Done" }], streaming: false, replayed: true,
} satisfies AcpUiEvent;
const tool = {
  kind: "tool_call", toolCallId: "t1", title: "Run task", status: "completed", content: null, locations: [],
} satisfies AcpUiEvent;

test("internal projector facts do not change live wire JSON", () => {
  const enriched: AcpUiEvent[] = [
    { ...user, messageId: null, turnKey },
    { ...agent, messageId: "m1" },
    { ...tool, delta: { phase: "update", title: null, kind: null, status: null, content: null, locations: null } },
  ];
  expect(JSON.stringify(enriched.map(toWireEvent))).toBe(JSON.stringify([user, agent, tool]));
});

function render(events: readonly AcpUiEvent[], capacity = 20): AcpUiEvent[] {
  const { items, live_state, is_truncated } = events.reduce(
    (buffer, event) => foldUpdate(buffer, event).buffer, createTranscriptBuffer({ epoch, capacity }),
  );
  return renderLegacyEvents({ stream_epoch: epoch, items, live_state, is_truncated });
}

function view(events: AcpUiEvent[]) {
  const projection = projectTimeline(events);
  const withoutKey = ({ key, ...item }: TimelineItem) => item;
  return { ...projection, items: projection.items.map(withoutKey), openPermissions: projection.openPermissions.map(withoutKey) };
}

test("legacy replay retains visible messages, tool values, plan, permissions, notes and live values", () => {
  const original: AcpUiEvent[] = [
    user, { ...agent, content: [{ type: "text", text: "Do" }] },
    { ...agent, content: [{ type: "text", text: "ne" }] },
    { ...tool, status: "pending" }, { ...tool, title: "" },
    { kind: "plan", entries: [{ content: "run", status: "completed", priority: "high" }] },
    { kind: "permission", requestId: "perm-1", title: "Closed", options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }] },
    { kind: "permission_resolved", requestId: "perm-1", outcome: "selected", optionId: "yes" },
    { kind: "permission", requestId: "perm-2", title: "Still open", options: [] },
    { kind: "turn_state", turnKey, state: "failed", detail: "interrupted" },
    { kind: "config_options", options: [{ id: "mode", name: "Mode", category: null, type: "boolean", value: false, options: [] }] },
    { kind: "commands", commands: [{ name: "compact", description: "Compress" }] },
    { kind: "usage", used: 3, size: 100, cost: { amount: 1, currency: "USD" } },
    { kind: "session_info", title: "Test" },
    { kind: "turn_state", turnKey, state: "prompting" },
  ];
  const projected = [{ ...user, messageId: null, turnKey }, ...original.slice(1)];
  expect(view(render(projected))).toEqual(view(original));
});

test("folded history joins a repeated message ID even across a tool call", () => {
  const source: AcpUiEvent[] = [
    { ...agent, content: [{ type: "text", text: "Do" }] }, tool,
    { ...agent, content: [{ type: "text", text: "ne" }] },
  ];
  expect(projectTimeline(source).items.filter((item) => item.kind === "agent").map((item) => item.text))
    .toEqual(["Do", "ne"]);
  expect(projectTimeline(render(source)).items.filter((item) => item.kind === "agent").map((item) => item.text))
    .toEqual(["Done"]);
});

test("legacy replay retains an unanswered permission after its item is evicted", () => {
  const events: AcpUiEvent[] = [
    { kind: "permission", requestId: "perm-7", title: "Allow?", options: [] }, tool,
  ];
  expect(projectTimeline(render(events, 1)).openPermissions).toMatchObject([{ requestId: "perm-7", title: "Allow?" }]);
});

test("empty history renders no legacy events", () => {
  expect(renderLegacyEvents(null)).toEqual([]);
});

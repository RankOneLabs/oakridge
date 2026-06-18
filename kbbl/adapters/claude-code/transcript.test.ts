import { describe, test, expect } from "bun:test";

import {
  parseTranscriptEntry,
  transcriptEntryToEvents,
  unwrapChannelContent,
} from "./transcript";

// Shapes lifted from a real CC transcript (PTY mode) — one content block per
// assistant line, Anthropic usage bag, isSidechain on subagent turns.
const userLine = {
  type: "user",
  uuid: "u-1",
  promptSource: "typed",
  message: { role: "user", content: "fix the bug" },
};

const assistantTextLine = {
  type: "assistant",
  uuid: "a-1",
  requestId: "req_1",
  message: {
    id: "msg_1",
    model: "claude-opus-4-8",
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "text", text: "Looking into it." }],
    usage: { input_tokens: 100, output_tokens: 20 },
  },
};

const assistantEndTurnLine = {
  type: "assistant",
  uuid: "a-2",
  message: {
    id: "msg_2",
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Done." }],
    usage: {
      input_tokens: 5,
      output_tokens: 50,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 1000,
      // fields the projection must ignore:
      service_tier: "standard",
      iterations: [{ input_tokens: 5 }],
    },
  },
};

describe("parseTranscriptEntry", () => {
  test("returns null for non-objects and missing type", () => {
    expect(parseTranscriptEntry(null)).toBeNull();
    expect(parseTranscriptEntry("nope")).toBeNull();
    expect(parseTranscriptEntry({ message: {} })).toBeNull();
  });

  test("returns null for a user line with no message / wrong role", () => {
    expect(parseTranscriptEntry({ type: "user" })).toBeNull();
    expect(
      parseTranscriptEntry({ type: "user", message: { role: "assistant", content: "x" } }),
    ).toBeNull();
  });

  test("accepts a known-but-unmapped entry type as the open arm", () => {
    const entry = parseTranscriptEntry({ type: "ai-title", title: "x" });
    expect(entry).not.toBeNull();
    expect(entry?.type).toBe("ai-title");
  });
});

describe("transcriptEntryToEvents", () => {
  test("maps a user line to a single user event carrying the message", () => {
    const events = transcriptEntryToEvents(userLine);
    expect(events).toEqual([
      { type: "user", payload: { type: "user", message: userLine.message } },
    ]);
  });

  test("maps a mid-turn assistant line to one assistant event, no result", () => {
    const events = transcriptEntryToEvents(assistantTextLine);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
    expect(events[0].payload).toEqual({
      type: "assistant",
      message: assistantTextLine.message,
    });
  });

  test("emits a result carrying stop_reason, content, and projected usage on end_turn", () => {
    const events = transcriptEntryToEvents(assistantEndTurnLine);
    expect(events.map((e) => e.type)).toEqual(["assistant", "result"]);
    // stop_reason + content are what extractCompactMarkdown and the CC
    // classifier read; usage feeds the metrics strip.
    expect(events[1].payload).toEqual({
      type: "result",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Done." }],
      usage: {
        input_tokens: 5,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 1000,
      },
    });
  });

  test("skips sidechain (subagent-internal) entries", () => {
    expect(
      transcriptEntryToEvents({ ...assistantEndTurnLine, isSidechain: true }),
    ).toEqual([]);
    expect(
      transcriptEntryToEvents({ ...userLine, isSidechain: true }),
    ).toEqual([]);
  });

  test("skips unmapped entry types and malformed lines", () => {
    expect(transcriptEntryToEvents({ type: "file-history-snapshot" })).toEqual([]);
    expect(transcriptEntryToEvents({ type: "attachment" })).toEqual([]);
    expect(transcriptEntryToEvents(null)).toEqual([]);
    expect(transcriptEntryToEvents({ type: "user" })).toEqual([]);
  });

  test("passes tool_result (array content) user lines through", () => {
    const toolResult = {
      type: "user",
      uuid: "u-2",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    };
    const events = transcriptEntryToEvents(toolResult);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user");
  });

  test("unwraps a channel-origin user line into a clean user event", () => {
    // CC writes a kbbl channel push into its transcript as a channel-origin user
    // row wrapped in `<channel>…</channel>`, when it actually ingests the
    // message. Core does NOT synthesize for CC, so this row is the single source
    // for the operator's message — the transform unwraps the shell so it renders
    // as clean text (and reconciles the optimistic pending bubble, which holds
    // the raw text).
    const channelRow = {
      type: "user",
      uuid: "u-3",
      isMeta: true,
      promptSource: "system",
      origin: { kind: "channel", server: "kbbl-channel" },
      message: {
        role: "user",
        content:
          '<channel source="kbbl-channel" source="kbbl">\nany current sweeps?\n</channel>',
      },
    };
    expect(transcriptEntryToEvents(channelRow)).toEqual([
      {
        type: "user",
        payload: {
          type: "user",
          message: { role: "user", content: "any current sweeps?" },
        },
      },
    ]);
  });

  test("unwrapChannelContent strips the wrapper and newline padding", () => {
    expect(
      unwrapChannelContent(
        '<channel source="kbbl-channel" source="kbbl">\nhello world\n</channel>',
      ),
    ).toBe("hello world");
    // Multiline operator input survives intact (only the outer padding goes).
    expect(
      unwrapChannelContent("<channel source=\"kbbl\">\nline one\nline two\n</channel>"),
    ).toBe("line one\nline two");
    // A string that isn't channel-wrapped is returned unchanged.
    expect(unwrapChannelContent("just text")).toBe("just text");
  });

  test("result usage defaults missing token fields to zero", () => {
    const line = {
      type: "assistant",
      uuid: "a-3",
      message: { role: "assistant", stop_reason: "end_turn", content: [], usage: {} },
    };
    const events = transcriptEntryToEvents(line);
    expect(events[1].payload).toEqual({
      type: "result",
      stop_reason: "end_turn",
      content: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
  });

  test("result usage is fully numeric even when the usage bag is absent", () => {
    const line = {
      type: "assistant",
      uuid: "a-4",
      message: { role: "assistant", stop_reason: "end_turn", content: [] },
    };
    const events = transcriptEntryToEvents(line);
    expect(events[1].payload).toEqual({
      type: "result",
      stop_reason: "end_turn",
      content: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
  });
});

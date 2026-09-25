import { expect, test } from "bun:test";

import { buildResumeContext } from "./resume-context";
import type { AcpUiEvent, KbblSessionId, UiSessionHistory } from "./types";

test("resume context joins message chunks before trimming and labeling", () => {
  const events: AcpUiEvent[] = [
    { kind: "user_message", id: "user-1", content: [{ type: "text", text: "hello " }], replayed: true },
    { kind: "user_message", id: "user-1", content: [{ type: "text", text: "world" }], replayed: true },
    { kind: "agent_message", id: "agent-1", content: [{ type: "text", text: "good " }], streaming: true, replayed: true },
    { kind: "agent_message", id: "agent-1", content: [{ type: "text", text: "morning" }], streaming: false, replayed: true },
  ];
  const history: UiSessionHistory = { kind: "transcript", sid: "parent" as KbblSessionId, events, openTurns: [], expired: false, summary: null };

  const context = buildResumeContext("parent", history);
  expect(context).toContain("User: hello world\n\nAssistant: good morning");
});

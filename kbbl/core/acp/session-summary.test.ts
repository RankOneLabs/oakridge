import { expect, test } from "bun:test";

import {
  FinalResponseSummaryGenerator,
  ManualCompactionSummaryGenerator,
  generateSessionSummary,
} from "./session-summary";
import type { KbblSessionId } from "./types";

const sid = "00000000-0000-4000-8000-000000000001" as KbblSessionId;
const request = {
  session_id: sid,
  produced_at: "2026-09-23T00:00:00.000Z",
  events: [
    { kind: "user_message" as const, id: "u1", content: [{ type: "text" as const, text: "first" }], replayed: false },
    { kind: "agent_message" as const, id: "a1", content: [{ type: "text" as const, text: "old" }], streaming: false, replayed: false },
    { kind: "user_message" as const, id: "u2", content: [{ type: "text" as const, text: "second" }], replayed: false },
    { kind: "agent_message" as const, id: "a2", content: [{ type: "text" as const, text: "final " }], streaming: true, replayed: false },
    { kind: "agent_message" as const, id: "a2", content: [{ type: "text" as const, text: "answer" }], streaming: true, replayed: false },
  ],
};

test("final-response summary retains only the latest assistant turn", async () => {
  const result = await new FinalResponseSummaryGenerator().generate(request);
  expect(result).toEqual({
    ok: true,
    value: {
      schema_version: 1,
      session_id: sid,
      method: "final_response",
      produced_at: request.produced_at,
      markdown: "final answer",
    },
  });
});

test("manual compaction is an explicit replaceable generator", async () => {
  const result = await new ManualCompactionSummaryGenerator().generate({
    ...request,
    events: [
      { kind: "user_message", id: "compact", content: [{ type: "text", text: "/compact" }], replayed: false },
      { kind: "agent_message", id: "handoff", content: [{ type: "text", text: "# compact handoff" }], streaming: false, replayed: false },
    ],
  });
  expect(result.ok && result.value.method).toBe("manual_compaction");
});

test("summary strategy runner falls through typed generator failures", async () => {
  const manual = new ManualCompactionSummaryGenerator();
  const result = await generateSessionSummary(request, [manual, new FinalResponseSummaryGenerator()]);
  expect(result.ok && result.value.method).toBe("final_response");
});

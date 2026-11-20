import { expect, test } from "bun:test";

import {
  FinalResponseSummaryGenerator,
  ManualCompactionSummaryGenerator,
  generateSessionSummary,
} from "./session-summary";
import { transcriptItemId, transcriptSeq, type AgentMessageItem, type UserMessageItem } from "./transcript-model";
import type { KbblSessionId } from "./types";

const sid = "00000000-0000-4000-8000-000000000001" as KbblSessionId;
function user(index: number, text: string): UserMessageItem {
  const seq = transcriptSeq(index);
  return { kind: "user_message", id: transcriptItemId(seq), seq, message_id: null, turn_key: null, text, is_replayed: false };
}

function agent(index: number, text: string): AgentMessageItem {
  const seq = transcriptSeq(index);
  return { kind: "agent_message", id: transcriptItemId(seq), seq, message_id: null, text, is_streaming: false, is_replayed: false };
}

const request = {
  session_id: sid,
  produced_at: "2026-09-23T00:00:00.000Z",
  items: [user(0, "first"), agent(1, "old"), user(2, "second"), agent(3, "final "), agent(4, "answer")],
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
    items: [user(0, " /compact "), agent(1, " # compact handoff ")],
  });
  expect(result.ok && result.value).toMatchObject({ method: "manual_compaction", markdown: "# compact handoff" });
});

test("summary strategy runner falls through typed generator failures", async () => {
  const manual = new ManualCompactionSummaryGenerator();
  const result = await generateSessionSummary(request, [manual, new FinalResponseSummaryGenerator()]);
  expect(result.ok && result.value.method).toBe("final_response");
});

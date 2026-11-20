import { expect, test } from "bun:test";
import { buildResumeContext } from "./resume-context";
import { EMPTY_SESSION_LIVE_STATE, streamEpoch, transcriptItemId, transcriptSeq, type TranscriptItem } from "./transcript-model";
import type { KbblSessionId, UiSessionHistory } from "./types";

test("resume context trims and labels folded messages in sequence", () => {
  const items: TranscriptItem[] = [
    { kind: "user_message", id: transcriptItemId(transcriptSeq(0)), seq: transcriptSeq(0), message_id: null, turn_key: null, text: " hello world ", is_replayed: true },
    { kind: "agent_message", id: transcriptItemId(transcriptSeq(1)), seq: transcriptSeq(1), message_id: null, text: "good morning ", is_replayed: true, is_streaming: false },
    { kind: "agent_message", id: transcriptItemId(transcriptSeq(2)), seq: transcriptSeq(2), message_id: null, text: "  ", is_replayed: true, is_streaming: false },
  ];
  const history: UiSessionHistory = {
    kind: "transcript", sid: "parent" as KbblSessionId,
    transcript: { stream_epoch: streamEpoch("test"), items, is_truncated: false, live_state: EMPTY_SESSION_LIVE_STATE },
    openTurns: [], expired: false, summary: null,
  };

  expect(buildResumeContext("parent", history)).toContain(
    "User: hello world\n\nAssistant: good morning\n\nContinue from this context",
  );
});

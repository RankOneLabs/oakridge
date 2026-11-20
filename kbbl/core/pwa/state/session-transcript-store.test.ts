import { expect, it } from "vitest";
import { applyIncrementalFrames } from "../lib/session-frames";
import { getSessionTranscriptStore, releaseSessionTranscriptStore, selectOrderedItems } from "./session-transcript-store";

it("isolates frames by session and releases its stored state", () => {
  const first = getSessionTranscriptStore("a");
  const second = getSessionTranscriptStore("b");
  const secondState = second.getState();
  try {
    first.setState((state) => applyIncrementalFrames(state, [{ kind: "stream_error", error: "offline", code: "test" }]));
    expect(getSessionTranscriptStore("a")).toBe(first);
    expect(first.getState().connection.stream_error).toBe("offline");
    expect(second.getState()).toBe(secondState);
    expect(selectOrderedItems(first.getState())).toBe(selectOrderedItems(secondState));
    releaseSessionTranscriptStore("a");
    expect(getSessionTranscriptStore("a")).not.toBe(first);
  } finally {
    releaseSessionTranscriptStore("a");
    releaseSessionTranscriptStore("b");
  }
});

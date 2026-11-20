import { useExternalStoreRuntime } from "@assistant-ui/react";
import { convertTranscriptItem } from "../lib/thread-messages";
import { selectOrderedItems, useSessionTranscript } from "../state/session-transcript-store";
import type { useSendInput } from "./useSendInput";

type SendInput = ReturnType<typeof useSendInput>["send"];

export function useSessionThreadRuntime(sid: string, send: SendInput) {
  const items = useSessionTranscript(sid, selectOrderedItems);
  const isRunning = useSessionTranscript(sid, (state) => state.session_state.active_turn !== null);

  return useExternalStoreRuntime({
    messages: items,
    isRunning,
    convertMessage: convertTranscriptItem,
    onNew: async (message) => {
      const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
      if (text.trim()) await send(text);
    },
  });
}

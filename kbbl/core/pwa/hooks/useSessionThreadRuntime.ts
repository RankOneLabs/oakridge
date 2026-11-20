import { useExternalStoreRuntime } from "@assistant-ui/react";
import { useMemo } from "react";
import { selectSessionTranscriptItems } from "../lib/session-items";
import { convertTranscriptItem } from "../lib/thread-messages";
import { selectOrderedItems, useSessionTranscript } from "../state/session-transcript-store";
import type { useSendInput } from "./useSendInput";

type SendInput = ReturnType<typeof useSendInput>["send"];

export function useSessionThreadRuntime(sid: string, send: SendInput) {
  const items = useSessionTranscript(sid, selectOrderedItems);
  const open_permissions = useSessionTranscript(sid, (state) => state.session_state.open_permissions);
  const latest_plan = useSessionTranscript(sid, (state) => state.session_state.latest_plan);
  const isRunning = useSessionTranscript(sid, (state) => state.session_state.active_turn !== null);
  const messages = useMemo(
    () => selectSessionTranscriptItems(items, { open_permissions, latest_plan }),
    [items, open_permissions, latest_plan],
  );

  return useExternalStoreRuntime({
    messages,
    isRunning,
    convertMessage: convertTranscriptItem,
    onNew: async (message) => {
      const text = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
      if (text.trim()) await send(text);
    },
  });
}

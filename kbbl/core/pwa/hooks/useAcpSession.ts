import { selectOrderedItems, useSessionTranscript } from "../state/session-transcript-store";
import { useAcpSessionMetadata } from "./useAcpSessionMetadata";

export function useAcpSession(sid: string) {
  return {
    ...useAcpSessionMetadata(sid),
    items: useSessionTranscript(sid, selectOrderedItems),
    transcriptVersion: useSessionTranscript(sid, (state) => state.transcript_version),
  };
}

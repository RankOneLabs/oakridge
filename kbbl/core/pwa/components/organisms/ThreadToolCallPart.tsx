import { useAuiState } from "@assistant-ui/react";
import { useCallback } from "react";
import { openEnumSpelling } from "../../../acp/transcript-transforms";
import { useSessionTranscript, type SessionTranscriptState } from "../../state/session-transcript-store";
import type { TranscriptItemId } from "../../types";
import { ToolCallCard } from "../molecules/ToolCallCard";

interface ThreadToolCallPartProps {
  sid: string;
}

export function ThreadToolCallPart({ sid }: ThreadToolCallPartProps) {
  // The runtime preserves each transcript item ID as its message ID.
  const id = useAuiState((state) => state.message.id) as TranscriptItemId;
  const selectTool = useCallback((state: SessionTranscriptState) => state.items_by_id.get(id), [id]);
  const item = useSessionTranscript(sid, selectTool);
  if (item?.kind !== "tool_call") return null;
  return <ToolCallCard title={item.title} status={openEnumSpelling(item.status)}
    content={item.content.length ? item.content : null} locations={item.locations} />;
}

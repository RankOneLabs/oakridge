import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { useCallback } from "react";
import { openEnumSpelling } from "../../../acp/transcript-transforms";
import { selectToolItemByCallId } from "../../lib/thread-messages";
import { useSessionTranscript, type SessionTranscriptState } from "../../state/session-transcript-store";
import { ToolCallCard } from "../molecules/ToolCallCard";

interface ThreadToolCallPartProps extends Pick<ToolCallMessagePartProps, "toolCallId"> {
  sid: string;
}

export function ThreadToolCallPart({ sid, toolCallId }: ThreadToolCallPartProps) {
  const selectTool = useCallback((state: SessionTranscriptState) => selectToolItemByCallId(state, toolCallId), [toolCallId]);
  const item = useSessionTranscript(sid, selectTool);
  if (!item) return null;
  return <ToolCallCard title={item.title} status={openEnumSpelling(item.status)}
    content={item.content.length ? item.content : null} locations={item.locations} />;
}

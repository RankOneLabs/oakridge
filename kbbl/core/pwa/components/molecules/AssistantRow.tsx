import { Fragment } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

import type { EnvelopeEvent, CCAssistantPayload, ContentBlock } from "../../types";
import { MessageTimestamp } from "../atoms/MessageTimestamp";
import { ToolUseCard } from "./ToolUseCard";
import { UnknownRow } from "../atoms/UnknownRow";

export function AssistantRow({
  event,
  showSystemEvents,
  isLatest,
}: {
  event: EnvelopeEvent;
  showSystemEvents: boolean;
  isLatest: boolean;
}) {
  const p = event.payload as CCAssistantPayload;
  // Cast to unknown so TypeScript narrows correctly: CCAssistantPayload types
  // content as ContentBlock[] but Codex assistant events carry a plain string.
  const rawContent: unknown = p.message?.content;
  const blocks: ContentBlock[] = typeof rawContent === "string"
    ? [{ type: "text", text: rawContent }]
    : Array.isArray(rawContent) ? (rawContent as ContentBlock[]) : [];
  // Pin the timestamp to the last text block in this event so a turn that
  // ends with a tool_use doesn't drop the stamp on the wrong card.
  let lastTextIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === "text") {
      lastTextIdx = i;
      break;
    }
  }
  return (
    <>
      {blocks.map((block, idx) => {
        const key = `${event.id}-${idx}`;
        if (block.type === "text") {
          const showTs = isLatest && idx === lastTextIdx;
          return (
            <Fragment key={key}>
              {showTs && (
                <div className="row row-assistant">
                  <MessageTimestamp iso={event.ts} />
                </div>
              )}
              <div className="row row-assistant">
                <div className="bubble bubble-assistant">
                  <Markdown rehypePlugins={[rehypeSanitize]}>
                    {block.text}
                  </Markdown>
                </div>
              </div>
            </Fragment>
          );
        }
        if (block.type === "thinking") {
          return (
            <details key={key} className="row row-thinking">
              <summary>thinking</summary>
              <pre>{block.thinking}</pre>
            </details>
          );
        }
        if (block.type === "tool_use") {
          return <ToolUseCard key={key} block={block as Extract<ContentBlock, { type: "tool_use" }>} />;
        }
        return (
          <UnknownRow
            key={key}
            event={event}
            compact={!showSystemEvents}
          />
        );
      })}
    </>
  );
}

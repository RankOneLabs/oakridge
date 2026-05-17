import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

import type { InFlightAssistant, ContentBlock } from "../../types";
import { InFlightToolPanel } from "./InFlightToolPanel";

// Renders the live assistant turn reconstructed from --include-partial-messages
// stream events. Stays mounted only until the matching final `assistant` event
// arrives, at which point useInFlightAssistant returns null and the EventList's
// AssistantRow takes over with the canonical version.
export function InFlightAssistantRow({ message }: { message: InFlightAssistant }) {
  const toolUseBlocks = message.blocks.filter(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
      b.type === "tool_use",
  );
  return (
    <>
      {message.blocks.map((block, idx) => {
        const key = `inflight-${idx}`;
        if (block.type === "thinking") {
          if (block.thinking.length === 0) return null;
          return (
            <details key={key} className="row row-thinking" open>
              <summary>thinking · live</summary>
              <pre>{block.thinking}</pre>
            </details>
          );
        }
        if (block.type === "text") {
          if (block.text.length === 0) return null;
          return (
            <div key={key} className="row row-assistant">
              <div className="bubble bubble-assistant bubble-assistant-inflight">
                <Markdown rehypePlugins={[rehypeSanitize]}>
                  {block.text}
                </Markdown>
              </div>
            </div>
          );
        }
        return null;
      })}
      {toolUseBlocks.length > 0 && (
        <InFlightToolPanel blocks={toolUseBlocks} />
      )}
    </>
  );
}

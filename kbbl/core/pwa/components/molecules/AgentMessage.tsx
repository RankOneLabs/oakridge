import { memo } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

// Completed messages keep the same text while new chunks arrive elsewhere.
// Avoid parsing their Markdown again on every transcript or timer update.
export const AgentMessage = memo(function AgentMessage({ text }: { text: string }) {
  return (
    <div className="row row-assistant">
      <div className="bubble bubble-assistant">
        <Markdown rehypePlugins={[rehypeSanitize]}>{text}</Markdown>
      </div>
    </div>
  );
});

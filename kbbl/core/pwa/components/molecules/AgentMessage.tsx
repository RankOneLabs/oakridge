import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

export function AgentMessage({ text }: { text: string }) {
  return (
    <div className="row row-assistant">
      <div className="bubble bubble-assistant">
        <Markdown rehypePlugins={[rehypeSanitize]}>{text}</Markdown>
      </div>
    </div>
  );
}

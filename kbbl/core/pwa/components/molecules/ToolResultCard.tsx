import type { ContentBlock } from "../../types";

export function ToolResultCard({
  block,
  eventId,
}: {
  block: Extract<ContentBlock, { type: "tool_result" }>;
  eventId: number;
}) {
  const content =
    typeof block.content === "string"
      ? block.content
      : (JSON.stringify(block.content ?? null) ?? "null");
  const preview = content.length > 80 ? content.slice(0, 80) + "…" : content;
  return (
    <details
      className={`card card-tool-result ${block.is_error ? "is-error" : ""}`}
    >
      <summary>
        <span className="card-label">
          tool_result{block.is_error ? " (error)" : ""}
        </span>
        <span className="card-preview">{preview || <em>empty</em>}</span>
      </summary>
      <pre className="card-body">{content}</pre>
      <div className="card-footer">id #{eventId} · tool_use_id {block.tool_use_id.slice(0, 12)}…</div>
    </details>
  );
}

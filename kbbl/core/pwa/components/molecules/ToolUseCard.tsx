import type { ContentBlock } from "../../types";

export function ToolUseCard({
  block,
}: {
  block: Extract<ContentBlock, { type: "tool_use" }>;
}) {
  // JSON.stringify(undefined) returns undefined, not the string "undefined";
  // coalesce to null so preview is always a string even for malformed inputs.
  const preview = JSON.stringify(block.input ?? null) ?? "null";
  const short = preview.length > 80 ? preview.slice(0, 80) + "…" : preview;
  return (
    <details className="card card-tool-use">
      <summary>
        <span className="card-label">tool_use</span>
        <span className="card-name">{block.name}</span>
        <span className="card-preview">{short}</span>
      </summary>
      <pre className="card-body">{JSON.stringify(block.input, null, 2)}</pre>
    </details>
  );
}

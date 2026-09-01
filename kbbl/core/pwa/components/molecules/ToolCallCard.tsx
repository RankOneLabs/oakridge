import type { UiToolLocation } from "../../types";

function contentPreview(content: unknown): string {
  if (content === null || content === undefined) return "";
  // ACP tool content is structured (content blocks, diffs, terminal
  // refs); a JSON preview is the §13.2 fallback until richer renderers
  // are worth their weight.
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  return raw.length > 80 ? raw.slice(0, 80) + "…" : raw;
}

export function ToolCallCard({
  title,
  status,
  content,
  locations,
}: {
  title: string;
  status: string;
  content: unknown;
  locations: readonly UiToolLocation[];
}) {
  const body =
    content === null || content === undefined
      ? null
      : typeof content === "string"
        ? content
        : JSON.stringify(content, null, 2);
  return (
    <details className="card card-tool-use">
      <summary>
        <span className={`card-label card-tool-status-${status}`}>{status}</span>
        <span className="card-name">{title || "tool"}</span>
        <span className="card-preview">{contentPreview(content)}</span>
      </summary>
      {locations.length > 0 && (
        <div className="card-tool-locations">
          {locations.map((location, idx) => (
            <span key={`${location.path}-${idx}`} className="card-tool-location">
              {location.path}
              {location.line != null ? `:${location.line}` : ""}
            </span>
          ))}
        </div>
      )}
      {body !== null && <pre className="card-body">{body}</pre>}
    </details>
  );
}

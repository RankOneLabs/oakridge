import { memo, useMemo } from "react";

import type { ToolUseEntry, ToolResultEntry } from "../../types";
import { previewToolInput } from "../../lib/events";

// Memoized: a YOLO-mode batch can carry 50+ entries each holding a
// non-trivial input/result payload. Without memo every transcript scroll /
// SSE event re-runs the full JSON.stringify on every entry. Inputs are
// stable once they arrive (results land once, then never change), so memo
// against the use+result identity is safe.
export const ToolBatchEntry = memo(function ToolBatchEntry({
  use,
  result,
}: {
  use: ToolUseEntry;
  result: ToolResultEntry | null;
}) {
  const inputPreview = useMemo(
    () => previewToolInput(use.name, use.input),
    [use.name, use.input],
  );
  const inputJson = useMemo(
    () => JSON.stringify(use.input, null, 2),
    [use.input],
  );
  const resultText = useMemo(() => {
    if (!result) return "";
    return typeof result.content === "string"
      ? result.content
      : (JSON.stringify(result.content ?? null) ?? "null");
  }, [result]);
  return (
    <details
      className={`tool-entry ${result?.isError ? "is-error" : ""} ${result ? "" : "is-pending"}`}
    >
      <summary>
        <span className="tool-entry-name">{use.name}</span>
        <span className="tool-entry-preview">{inputPreview}</span>
        {!result && <span className="tool-entry-status">pending…</span>}
        {result?.isError && <span className="tool-entry-status">error</span>}
      </summary>
      <div className="tool-entry-body">
        <div className="tool-entry-section-label">input</div>
        <pre className="tool-entry-block">{inputJson}</pre>
        {result && (
          <>
            <div className="tool-entry-section-label">
              result{result.isError ? " (error)" : ""}
            </div>
            <pre className="tool-entry-block">{resultText || "(empty)"}</pre>
          </>
        )}
      </div>
    </details>
  );
});

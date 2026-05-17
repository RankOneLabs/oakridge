import type { ContentBlock } from "../../types";
import { summarizeToolNames, previewToolInput } from "../../lib/events";

// Collapsible "what's CC doing right now" panel that surfaces tool_use
// blocks reconstructed from in-flight stream_events. Closed by default —
// the operator only needs the call count + tool names at a glance to know
// the session is making progress, and can expand to see individual calls
// when something looks stuck.
export function InFlightToolPanel({
  blocks,
}: {
  blocks: Array<Extract<ContentBlock, { type: "tool_use" }>>;
}) {
  return (
    <details className="tool-batch tool-batch-live">
      <summary className="tool-batch-summary">
        <span className="tool-batch-count">
          {blocks.length} tool call{blocks.length === 1 ? "" : "s"}
        </span>
        <span className="tool-batch-names">
          {summarizeToolNames(blocks.map((b) => b.name || "?"))}
        </span>
        <span className="tool-batch-status tool-batch-status-live">
          working
        </span>
      </summary>
      <div className="tool-batch-body">
        {blocks.map((block, idx) => {
          const preview = previewToolInput(block.name, block.input);
          return (
            <div
              key={`live-${idx}`}
              className="tool-entry tool-entry-live is-pending"
            >
              <div className="tool-entry-live-summary">
                <span className="tool-entry-name">{block.name || "?"}</span>
                <span className="tool-entry-preview">{preview}</span>
                <span className="tool-entry-status">running…</span>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

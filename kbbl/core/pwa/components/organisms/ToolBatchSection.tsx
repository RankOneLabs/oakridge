import type { EnvelopeEvent, ToolUseEntry, ToolResultEntry, CCAssistantPayload, CCUserPayload } from "../../types";
import { summarizeToolNames } from "../../lib/events";
import { ToolBatchEntry } from "../molecules/ToolBatchEntry";

export function ToolBatchSection({ events }: { events: EnvelopeEvent[] }) {
  const uses: ToolUseEntry[] = [];
  const results = new Map<string, ToolResultEntry>();
  for (const e of events) {
    if (e.type === "assistant") {
      const p = e.payload as CCAssistantPayload;
      for (const b of p.message?.content ?? []) {
        if (b.type === "tool_use") {
          uses.push({ id: b.id, name: b.name, input: b.input, eventId: e.id });
        }
      }
    } else if (e.type === "user") {
      const p = e.payload as CCUserPayload;
      const content = p.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "tool_result") {
            results.set(b.tool_use_id, {
              content: b.content,
              isError: !!b.is_error,
              eventId: e.id,
            });
          }
        }
      }
    }
  }
  if (uses.length === 0) return null;
  const errCount = uses.reduce(
    (n, u) => n + (results.get(u.id)?.isError ? 1 : 0),
    0,
  );
  return (
    <details className="tool-batch">
      <summary className="tool-batch-summary">
        <span className="tool-batch-count">
          {uses.length} tool call{uses.length === 1 ? "" : "s"}
        </span>
        <span className="tool-batch-names">
          {summarizeToolNames(uses.map((u) => u.name))}
        </span>
        {errCount > 0 && (
          <span className="tool-batch-errors">
            {errCount} error{errCount === 1 ? "" : "s"}
          </span>
        )}
      </summary>
      <div className="tool-batch-body">
        {uses.map((use) => (
          <ToolBatchEntry
            key={`${use.eventId}-${use.id}`}
            use={use}
            result={results.get(use.id) ?? null}
          />
        ))}
      </div>
    </details>
  );
}

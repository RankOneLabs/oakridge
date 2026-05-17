import type { EnvelopeEvent, CCUserPayload } from "../../types";
import { parseSlashCommand, parseLocalCommandStdout } from "../../lib/events";
import { MessageTimestamp } from "../atoms/MessageTimestamp";
import { ToolResultCard } from "./ToolResultCard";
import { UnknownRow } from "../atoms/UnknownRow";

export function UserRow({
  event,
  showSystemEvents,
  isLatest,
}: {
  event: EnvelopeEvent;
  showSystemEvents: boolean;
  isLatest: boolean;
}) {
  const p = event.payload as CCUserPayload & { isSynthetic?: boolean };
  const content = p.message?.content;

  // CC stamps post-compact summaries and skill-body injections with
  // isSynthetic. The summary is multi-page text; rendering it as a user
  // bubble misattributes it to the operator. Collapse behind an expand
  // affordance — the previous compact pill already marked when it ran.
  if (p.isSynthetic === true) {
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((b) =>
                b.type === "text"
                  ? b.text
                  : JSON.stringify(b, null, 2),
              )
              .join("\n\n")
          : JSON.stringify(content, null, 2);
    return (
      <div className="row row-user">
        <details className="bubble bubble-user bubble-user-slash">
          <summary>
            <span className="bubble-slash-name">[compacted — expand]</span>
          </summary>
          <pre className="bubble-slash-body">{text}</pre>
        </details>
      </div>
    );
  }

  if (typeof content === "string") {
    const slash = parseSlashCommand(content);
    if (slash) {
      return (
        <>
          {isLatest && (
            <div className="row row-user">
              <MessageTimestamp iso={event.ts} />
            </div>
          )}
          <div className="row row-user">
            <details className="bubble bubble-user bubble-user-slash">
              <summary>
                <span className="bubble-slash-name">/{slash.name}</span>
                {slash.args && (
                  <span className="bubble-slash-args">{slash.args}</span>
                )}
              </summary>
              <pre className="bubble-slash-body">{content}</pre>
            </details>
          </div>
        </>
      );
    }
    const stdout = parseLocalCommandStdout(content);
    if (stdout !== null) {
      const trimmed = stdout.trim();
      const firstLine = trimmed.split("\n", 1)[0] ?? "";
      return (
        <div className="row row-system" title={`event #${event.id}`}>
          <details className="notice">
            <summary>
              <span className="notice-tag">stdout</span>
              {firstLine || "(empty)"}
            </summary>
            <pre className="bubble-slash-body">{stdout}</pre>
          </details>
        </div>
      );
    }
    return (
      <>
        {isLatest && (
          <div className="row row-user">
            <MessageTimestamp iso={event.ts} />
          </div>
        )}
        <div className="row row-user">
          <div className="bubble bubble-user">{content}</div>
        </div>
      </>
    );
  }

  if (Array.isArray(content)) {
    return (
      <>
        {content.map((block, idx) => {
          if (block.type === "tool_result") {
            return (
              <ToolResultCard
                key={`${event.id}-${idx}`}
                block={block}
                eventId={event.id}
              />
            );
          }
          return (
            <UnknownRow
              key={`${event.id}-${idx}`}
              event={event}
              compact={!showSystemEvents}
            />
          );
        })}
      </>
    );
  }
  return <UnknownRow event={event} compact={!showSystemEvents} />;
}

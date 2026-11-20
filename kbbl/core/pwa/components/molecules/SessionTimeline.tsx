import { memo, type ReactNode } from "react";
import type { TimelineItem } from "../../lib/session-items";
import { AgentMessage } from "./AgentMessage";
import { UserMessage } from "./UserMessage";
import { ThoughtBlock } from "./ThoughtBlock";
import { ToolCallCard } from "./ToolCallCard";
import { PlanCard } from "./PlanCard";
import { TurnStateNotice } from "./TurnStateNotice";

// Timer and inbox updates do not change the memoized timeline projection.
export const SessionTimeline = memo(function SessionTimeline({
  renderPermission,
  items,
}: {
  renderPermission: (item: Extract<TimelineItem, { kind: "permission" }>) => ReactNode;
  sid: string;
  items: TimelineItem[];
  sessionClosed: boolean;
}) {
  return (
    <div className="events">
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return <UserMessage key={item.key} text={item.text} />;
          case "agent":
            return <AgentMessage key={item.key} text={item.text} />;
          case "thought":
            return <ThoughtBlock key={item.key} text={item.text} />;
          case "tool":
            return (
              <ToolCallCard
                key={item.key}
                title={item.title}
                status={item.status}
                content={item.content}
                locations={item.locations}
              />
            );
          case "plan":
            return <PlanCard key={item.key} entries={item.entries} />;
          case "permission":
            return renderPermission(item);
          case "turn_note":
            return (
              <TurnStateNotice
                key={item.key}
                state={item.state}
                stopReason={item.stopReason}
                detail={item.detail}
              />
            );
        }
      })}
    </div>
  );
});

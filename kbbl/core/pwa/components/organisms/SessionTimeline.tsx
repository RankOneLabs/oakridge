import type { TimelineItem } from "../../lib/acp-timeline";
import { AgentMessage } from "../molecules/AgentMessage";
import { UserMessage } from "../molecules/UserMessage";
import { ThoughtBlock } from "../molecules/ThoughtBlock";
import { ToolCallCard } from "../molecules/ToolCallCard";
import { PlanCard } from "../molecules/PlanCard";
import { TurnStateNotice } from "../molecules/TurnStateNotice";
import { PermissionCard } from "./PermissionCard";

export function SessionTimeline({
  sid,
  items,
  sessionClosed,
}: {
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
            return (
              <PermissionCard
                key={item.key}
                sid={sid}
                requestId={item.requestId}
                title={item.title}
                options={item.options}
                resolution={item.resolution}
                sessionClosed={sessionClosed}
              />
            );
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
}

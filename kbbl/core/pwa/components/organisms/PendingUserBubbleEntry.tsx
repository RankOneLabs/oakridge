import type { ComponentProps } from "react";
import { useRelativeTime } from "../../hooks/useRelativeTime";
import { PendingUserBubble } from "../molecules/PendingUserBubble";
type PendingUserBubbleEntryProps = Omit<ComponentProps<typeof PendingUserBubble>, "relativeText">;
export function PendingUserBubbleEntry(props: PendingUserBubbleEntryProps) {
  const relativeText = useRelativeTime(new Date(props.sentAt).toISOString());
  return <PendingUserBubble {...props} relativeText={relativeText} />;
}

import type { ComponentProps } from "react";
import { useRelativeTime } from "../../hooks/useRelativeTime";
import { PendingUserBubble } from "../molecules/PendingUserBubble";
interface PendingUserBubbleEntryProps extends Omit<ComponentProps<typeof PendingUserBubble>, "relativeText"> {}
export function PendingUserBubbleEntry({ text, sentAt, isLatest, status }: PendingUserBubbleEntryProps) {
  const relativeText = useRelativeTime(new Date(sentAt).toISOString());
  return <PendingUserBubble text={text} sentAt={sentAt} isLatest={isLatest} status={status} relativeText={relativeText} />;
}

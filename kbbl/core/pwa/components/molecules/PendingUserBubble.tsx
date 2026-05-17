import { useState, useEffect } from "react";

import { MessageTimestamp } from "../atoms/MessageTimestamp";

export function PendingUserBubble({
  text,
  sentAt,
  isLatest,
}: {
  text: string;
  sentAt: number;
  isLatest: boolean;
}) {
  // Re-render once after the 2s threshold so the label rolls from "sending"
  // to "delivered, awaiting reply" without polling forever.
  const [, setTick] = useState(0);
  useEffect(() => {
    const elapsed = Date.now() - sentAt;
    const remaining = Math.max(0, 2000 - elapsed);
    const t = setTimeout(() => setTick((x) => x + 1), remaining + 50);
    return () => clearTimeout(t);
  }, [sentAt]);
  const slow = Date.now() - sentAt > 2000;
  return (
    <>
      {isLatest && (
        <div className="row row-user">
          <MessageTimestamp iso={new Date(sentAt).toISOString()} />
        </div>
      )}
      <div className="row row-user">
        <div className="bubble bubble-user bubble-user-pending">
          {text}
          <span className="bubble-pending-tag">
            {slow ? "delivered · awaiting reply" : "sending…"}
          </span>
        </div>
      </div>
    </>
  );
}

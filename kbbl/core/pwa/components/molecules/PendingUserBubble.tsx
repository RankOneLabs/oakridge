import { useState, useEffect } from "react";

import type { PendingSend } from "../../types";
import { MessageTimestamp } from "../atoms/MessageTimestamp";

export function PendingUserBubble({
  relativeText,
  text,
  sentAt,
  isLatest,
  status,
}: {
  relativeText: string;
  text: string;
  sentAt: number;
  isLatest: boolean;
  status: PendingSend["status"];
}) {
  const [, setTick] = useState(0);
  const slow = Date.now() - sentAt >= 2000;
  useEffect(() => {
    if (status !== "sending" || slow) return;
    const remaining = Math.max(0, sentAt + 2000 - Date.now());
    const timer = setTimeout(() => setTick((tick) => tick + 1), remaining);
    return () => clearTimeout(timer);
  }, [sentAt, slow, status]);
  return (
    <>
      {isLatest && (
        <div className="row row-user">
          <MessageTimestamp relativeText={relativeText} iso={new Date(sentAt).toISOString()} />
        </div>
      )}
      <div className="row row-user">
        <div className="bubble bubble-user bubble-user-pending">
          {text}
          <span className="bubble-pending-tag">
            {status === "accepted" ? "queued" : slow ? "delivery uncertain…" : "sending…"}
          </span>
        </div>
      </div>
    </>
  );
}

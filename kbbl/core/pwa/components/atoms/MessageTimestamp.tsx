import { useRelativeTime } from "../../hooks/useRelativeTime";
import { formatExactTime } from "../../lib/time";

export function MessageTimestamp({ iso }: { iso: string }) {
  const rel = useRelativeTime(iso);
  if (!rel) return null;
  return (
    <span className="bubble-ts" title={formatExactTime(iso)}>
      {rel}
    </span>
  );
}

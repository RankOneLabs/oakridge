import { formatExactTime } from "../../lib/time";

export function MessageTimestamp({ iso, relativeText }: { iso: string; relativeText: string }) {
  if (!relativeText) return null;
  return (
    <span className="bubble-ts" title={formatExactTime(iso)}>
      {relativeText}
    </span>
  );
}

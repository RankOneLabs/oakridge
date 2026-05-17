export function formatRelative(iso: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const deltaSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  // Floor rather than round for the larger unit conversions — a 1m30s-old
  // session showing as "2m ago" overstates the elapsed time. Labels
  // advance only once the next threshold is actually crossed.
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Module-scope formatter so the hover tooltip is shape-stable (seconds and
// time zone always present) and we don't spin up a new Intl instance per
// timestamp render. Use granular options because ECMA-402 forbids combining
// dateStyle/timeStyle with timeZoneName.
const exactTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});
export function formatExactTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return exactTimeFormatter.format(t);
}

// Returns ms-since-epoch for an ISO timestamp, or null if Date.parse fails.
// Stream events flow from the network and a malformed ts would otherwise
// poison the elapsed-timer math (NaN propagates through arithmetic and
// nullish-coalescing to never-render NaN).
export function parseIsoMs(s: string): number | null {
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

export function formatElapsedSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

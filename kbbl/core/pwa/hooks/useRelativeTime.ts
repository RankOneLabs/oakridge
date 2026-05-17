import { useState, useEffect } from "react";

import { formatRelative } from "../lib/time";

export function useRelativeTime(iso: string): string {
  // Re-render once per minute so "2m ago" doesn't get stale. A 60s tick is
  // coarse enough to stay off the render hot path but fine-grained enough
  // that operators see the list refresh before the data feels wrong.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  return formatRelative(iso);
}

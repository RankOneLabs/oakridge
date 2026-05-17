import { useState, useEffect } from "react";

import { formatRelative } from "../lib/time";
import { subscribeTick } from "../lib/tick";

export function useRelativeTime(iso: string): string {
  const [, setTick] = useState(0);
  useEffect(() => subscribeTick(() => setTick((x) => x + 1)), []);
  return formatRelative(iso);
}

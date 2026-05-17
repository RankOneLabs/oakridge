import { useState, useEffect } from "react";

// 1Hz tick while `active` so derived elapsed-time UI re-renders without
// polluting unrelated state.
export function useElapsedSeconds(
  startedAtMs: number | null,
  active: boolean,
): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (startedAtMs === null) return null;
  return Math.max(0, Math.floor((now - startedAtMs) / 1000));
}

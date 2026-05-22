import { useState, useEffect } from "react";

export type HandoffStatus = "idle" | "loading" | "ok" | "missing" | "error";

export function useSessionHandoff(
  sid: string,
  enabled: boolean,
): { handoff: string | null; status: HandoffStatus } {
  const [handoff, setHandoff] = useState<string | null>(null);
  const [status, setStatus] = useState<HandoffStatus>("idle");

  useEffect(() => {
    if (!enabled) return;
    if (status !== "idle") return;
    let cancelled = false;
    setStatus("loading");
    fetch(`/${encodeURIComponent(sid)}/handoff`)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) {
          setStatus("missing");
          return;
        }
        if (!r.ok) {
          setStatus("error");
          return;
        }
        const text = await r.text();
        if (cancelled) return;
        setHandoff(text);
        setStatus("ok");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, sid, status]);

  return { handoff, status };
}

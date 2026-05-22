import { useState, useEffect } from "react";

export type HandoffStatus = "idle" | "loading" | "ok" | "missing" | "error";

export function useSessionHandoff(
  sid: string,
  enabled: boolean,
): { handoff: string | null; status: HandoffStatus } {
  const [handoff, setHandoff] = useState<string | null>(null);
  const [status, setStatus] = useState<HandoffStatus>("idle");

  useEffect(() => {
    if (!enabled) {
      // Reset on disable so the next enable cycle re-fetches.
      setStatus("idle");
      setHandoff(null);
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setHandoff(null);
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
    // `status` is intentionally excluded — including it would cause the
    // effect to re-run after setStatus("loading"), and the previous
    // cleanup would cancel the in-flight fetch before it resolved,
    // wedging the hook at "loading" forever.
  }, [enabled, sid]);

  return { handoff, status };
}

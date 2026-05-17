import { useState, useEffect } from "react";

/**
 * Fetches the server's /config once on mount. Returns null until the
 * fetch resolves so callers can render a "loading" placeholder rather
 * than racing forms with empty defaults.
 */
export function useServerConfig(): {
  defaultWorkdir: string;
  softThresholdTokens: number;
  safirWebUrl: string;
} | null {
  const [config, setConfig] = useState<{
    defaultWorkdir: string;
    softThresholdTokens: number;
    safirWebUrl: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/config")
      .then((r) => {
        if (!r.ok) throw new Error(`config: ${r.status}`);
        return r.json() as Promise<{
          defaultWorkdir: string;
          softThresholdTokens?: number;
          safirWebUrl?: string;
        }>;
      })
      .then((data) => {
        if (!cancelled) setConfig({
          defaultWorkdir: data.defaultWorkdir,
          softThresholdTokens: typeof data.softThresholdTokens === "number"
            ? data.softThresholdTokens
            : 50000,
          safirWebUrl: typeof data.safirWebUrl === "string" && data.safirWebUrl.length > 0
            ? data.safirWebUrl
            : "http://localhost:3000",
        });
      })
      .catch(() => {
        // server may be down or this build is older — leave config null
      });
    return () => { cancelled = true; };
  }, []);
  return config;
}

/**
 * POST /api/runs mutation hook. Parses LaunchResponseSchema and
 * surfaces pending + error state so the form can react.
 */
import { useCallback, useState } from "react";

import { LaunchResponseSchema } from "../lib/types";
import type { LaunchResponse, RunSpec } from "../lib/types";

export function useLaunch(): {
  launch: (spec: RunSpec) => Promise<LaunchResponse | null>;
  pending: boolean;
  error: string | null;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = useCallback(
    async (spec: RunSpec): Promise<LaunchResponse | null> => {
      setPending(true);
      setError(null);
      try {
        const r = await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(spec),
        });
        if (!r.ok) {
          const text = await r.text();
          setError(`Launch failed (${r.status}): ${text}`);
          return null;
        }
        return LaunchResponseSchema.parse(await r.json());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setPending(false);
      }
    },
    [],
  );

  return { launch, pending, error };
}

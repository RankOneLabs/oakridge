/**
 * Cleanup actions for cells: archive, restore, and delete.
 * Each action calls the corresponding backend route and invokes
 * refresh() on success so the cell list re-fetches authoritative
 * archived/cleanable state from the server.
 *
 * Non-2xx responses surface an error string (the response body's
 * `error` field, or an HTTP status fallback). The caller is
 * responsible for displaying it.
 */
import { useCallback, useState } from "react";

import type { CellId } from "../lib/ids";

async function extractError(r: Response): Promise<string> {
  try {
    const body = (await r.json()) as { error?: string };
    return body.error ?? `HTTP ${r.status}`;
  } catch {
    return `HTTP ${r.status}`;
  }
}

export function useCellCleanup(refresh: () => Promise<void>): {
  archive: (cellId: CellId) => Promise<void>;
  restore: (cellId: CellId) => Promise<void>;
  remove: (cellId: CellId) => Promise<void>;
  error: string | null;
} {
  const [error, setError] = useState<string | null>(null);

  const archive = useCallback(
    async (cellId: CellId) => {
      setError(null);
      const r = await fetch(`/api/cells/${cellId}/archive`, { method: "POST" });
      if (!r.ok) {
        setError(await extractError(r));
        return;
      }
      await refresh();
    },
    [refresh],
  );

  const restore = useCallback(
    async (cellId: CellId) => {
      setError(null);
      const r = await fetch(`/api/cells/${cellId}/archive`, {
        method: "DELETE",
      });
      if (!r.ok) {
        setError(await extractError(r));
        return;
      }
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (cellId: CellId) => {
      setError(null);
      const r = await fetch(`/api/cells/${cellId}`, { method: "DELETE" });
      if (!r.ok) {
        setError(await extractError(r));
        return;
      }
      await refresh();
    },
    [refresh],
  );

  return { archive, restore, remove, error };
}

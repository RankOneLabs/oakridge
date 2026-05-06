/**
 * Tracks the selected cell in the URL hash (`#cell=<cell_id>`) so
 * refreshes preserve position and links work. Listens to
 * hashchange so back/forward also update state.
 */
import { useCallback, useEffect, useState } from "react";

function readHash(): string | null {
  const h = window.location.hash.slice(1);
  for (const part of h.split("&")) {
    const [k, v] = part.split("=");
    if (k === "cell" && v) return decodeURIComponent(v);
  }
  return null;
}

export function useHashSelection(): [string | null, (id: string) => void] {
  const [cellId, setCellId] = useState<string | null>(() => readHash());
  useEffect(() => {
    const onHash = () => setCellId(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const select = useCallback((id: string) => {
    window.location.hash = `cell=${id}`;
  }, []);
  return [cellId, select];
}

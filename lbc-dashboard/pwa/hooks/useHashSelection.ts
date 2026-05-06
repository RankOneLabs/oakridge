/**
 * Tracks the selected cell in the URL hash (`#cell=<cell_id>`) so
 * refreshes preserve position and links work. Listens to
 * hashchange so back/forward also update state.
 *
 * Read + write both go through ``URLSearchParams`` so encoding stays
 * symmetric and the read path doesn't throw on a hand-crafted hash
 * with malformed percent-encoding (which ``decodeURIComponent``
 * would). URLSearchParams uses the form-urlencoded decoder that
 * returns literals for invalid sequences instead of raising
 * URIError.
 */
import { useCallback, useEffect, useState } from "react";

function readHash(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get("cell");
}

export function useHashSelection(): [string | null, (id: string) => void] {
  const [cellId, setCellId] = useState<string | null>(() => readHash());
  useEffect(() => {
    const onHash = () => setCellId(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const select = useCallback((id: string) => {
    // Preserve any other hash params already present (none today,
    // but future filter / route state would live alongside ``cell``).
    const params = new URLSearchParams(window.location.hash.slice(1));
    params.set("cell", id);
    window.location.hash = params.toString();
  }, []);
  return [cellId, select];
}

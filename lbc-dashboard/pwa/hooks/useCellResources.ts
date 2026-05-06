/**
 * Cell detail / artifact / commits — the resource fetches that
 * need to refetch as new events land. ``refreshKey`` (typically the
 * event count) drives re-fetch.
 */
import { useEffect, useState } from "react";

import type { CellDetail, CommitSnapshot } from "../lib/types";

export function useCellDetail(
  cellId: string | null,
  refreshKey: number,
): CellDetail | null {
  const [detail, setDetail] = useState<CellDetail | null>(null);
  useEffect(() => {
    if (cellId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/cells/${encodeURIComponent(cellId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setDetail(data as CellDetail | null);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cellId, refreshKey]);
  return detail;
}

export function useArtifact(
  cellId: string | null,
  refreshKey: number,
): string | null {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    if (cellId === null) {
      setContent(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/cells/${encodeURIComponent(cellId)}/artifact`)
      .then((r) => (r.ok ? r.json() : { content: null }))
      .then((data) => {
        if (!cancelled) setContent(data.content as string | null);
      })
      .catch(() => {
        if (!cancelled) setContent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cellId, refreshKey]);
  return content;
}

export function useCommits(
  cellId: string | null,
  refreshKey: number,
): CommitSnapshot[] {
  const [commits, setCommits] = useState<CommitSnapshot[]>([]);
  useEffect(() => {
    if (cellId === null) {
      setCommits([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/cells/${encodeURIComponent(cellId)}/commits`)
      .then((r) => (r.ok ? r.json() : { commits: [] }))
      .then((data) => {
        if (!cancelled) setCommits(data.commits as CommitSnapshot[]);
      })
      .catch(() => {
        if (!cancelled) setCommits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cellId, refreshKey]);
  return commits;
}

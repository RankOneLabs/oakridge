/**
 * Top-level orchestrator. Full-width 'New run' section (LaunchForm +
 * ActiveRunsStrip) sits above the existing two-pane cell viewer so
 * the form has horizontal room and the viewer is untouched.
 */
import { useEffect, useState } from "react";

import { EmptyMessage } from "./components/atoms/EmptyMessage";
import { ActiveRunsStrip } from "./components/organisms/ActiveRunsStrip";
import { CellList } from "./components/organisms/CellList";
import { CellPanel } from "./components/organisms/CellPanel";
import { LaunchForm } from "./components/organisms/LaunchForm";
import { useCellEvents } from "./hooks/useCellEvents";
import {
  useArtifact,
  useCellDetail,
  useCommits,
} from "./hooks/useCellResources";
import { useCells } from "./hooks/useCells";
import { useEvalScores } from "./hooks/useEvalScores";
import { useHashSelection } from "./hooks/useHashSelection";
import type { Tab } from "./lib/types";

export function App() {
  const { cells } = useCells();
  const [selectedId, select] = useHashSelection();
  const events = useCellEvents(selectedId);
  // Debounce the artifact / commits / detail re-fetch. Without this,
  // selecting a cell with a long backlog turns one SSE replay into a
  // request burst — events.length increments per replayed message, so
  // each one would refetch all three resources independently. 150ms
  // coalesces the burst into one re-fetch after the replay settles.
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (events.length === 0) return;
    const t = window.setTimeout(() => {
      setRefreshKey((n) => n + 1);
    }, 150);
    return () => window.clearTimeout(t);
  }, [events.length]);
  const detail = useCellDetail(selectedId, refreshKey);
  const artifact = useArtifact(selectedId, refreshKey);
  const commits = useCommits(selectedId, refreshKey);
  const scores = useEvalScores(selectedId, refreshKey);
  const [tab, setTab] = useState<Tab>("events");

  // Auto-select the first cell on initial load if nothing's hashed.
  useEffect(() => {
    if (selectedId === null && cells.length > 0) {
      select(cells[0].cell_id);
    }
  }, [selectedId, cells, select]);

  return (
    <div className="m-0 flex h-screen flex-col font-sans">
      <section className="w-full shrink-0 border-b border-stone-200 bg-white">
        <h2 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-stone-400">
          New run
        </h2>
        <LaunchForm />
        <ActiveRunsStrip />
      </section>
      <div className="flex flex-1 overflow-hidden">
        <CellList cells={cells} selectedId={selectedId} onSelect={select} />
        <main className="flex flex-1 flex-col overflow-hidden">
          {selectedId === null ? (
            <EmptyMessage>Select a cell on the left.</EmptyMessage>
          ) : (
            <CellPanel
              detail={detail}
              events={events}
              artifact={artifact}
              commits={commits}
              scores={scores}
              tab={tab}
              onTab={setTab}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * Top-level orchestrator. Composes the cell list (left rail) +
 * cell panel (right) into a two-pane layout. Hooks own the data
 * fetching; this file owns wiring + tab state.
 */
import { useEffect, useState } from "react";

import { EmptyMessage } from "./components/atoms/EmptyMessage";
import { CellList } from "./components/organisms/CellList";
import { CellPanel } from "./components/organisms/CellPanel";
import { useCellEvents } from "./hooks/useCellEvents";
import {
  useArtifact,
  useCellDetail,
  useCommits,
} from "./hooks/useCellResources";
import { useCells } from "./hooks/useCells";
import { useHashSelection } from "./hooks/useHashSelection";
import type { Tab } from "./lib/types";

export function App() {
  const { cells } = useCells();
  const [selectedId, select] = useHashSelection();
  const events = useCellEvents(selectedId);
  // Use the event count as the artifact / commits / detail
  // refresh-key — when a new event lands, those resources may
  // have changed so re-fetch.
  const refreshKey = events.length;
  const detail = useCellDetail(selectedId, refreshKey);
  const artifact = useArtifact(selectedId, refreshKey);
  const commits = useCommits(selectedId, refreshKey);
  const [tab, setTab] = useState<Tab>("events");

  // Auto-select the first cell on initial load if nothing's hashed.
  useEffect(() => {
    if (selectedId === null && cells.length > 0) {
      select(cells[0].cell_id);
    }
  }, [selectedId, cells, select]);

  return (
    <div className="m-0 flex h-screen font-sans">
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
            tab={tab}
            onTab={setTab}
          />
        )}
      </main>
    </div>
  );
}

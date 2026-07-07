/**
 * Top-level dashboard orchestrator.
 *
 * Launch remains the default section. Tasks and Graders are first-class
 * top-level sections that reuse the same task catalog and task selection
 * state so a newly created task can be launched immediately.
 */
import { useEffect, useState } from "react";

import { EmptyMessage } from "./components/atoms/EmptyMessage";
import { TabButton } from "./components/atoms/TabButton";
import { ActiveRunsStrip } from "./components/organisms/ActiveRunsStrip";
import { GradersSection } from "./components/organisms/GradersSection";
import { LaunchForm } from "./components/organisms/LaunchForm";
import { TasksSection } from "./components/organisms/TasksSection";
import { CellList } from "./components/organisms/CellList";
import { CellPanel } from "./components/organisms/CellPanel";
import { useCellEvents } from "./hooks/useCellEvents";
import {
  useArtifact,
  useCellDetail,
  useCommits,
} from "./hooks/useCellResources";
import { useCellCleanup } from "./hooks/useCellCleanup";
import { useCells } from "./hooks/useCells";
import { useThrottledOrdering } from "./hooks/useThrottledOrdering";
import { useEvalScores } from "./hooks/useEvalScores";
import { useGraders } from "./hooks/useGraders";
import { useHashSelection } from "./hooks/useHashSelection";
import { useTasks } from "./hooks/useTasks";
import type { Tab, CellArchiveFilter } from "./lib/types";

type DashboardSection = "launch" | "tasks" | "graders";

const SECTION_LABELS: Array<{ key: DashboardSection; label: string }> = [
  { key: "launch", label: "Launch" },
  { key: "tasks", label: "Tasks" },
  { key: "graders", label: "Graders" },
];

export function App() {
  const [archiveFilter, setArchiveFilter] =
    useState<CellArchiveFilter>("default");
  const { cells, refresh: refreshCells } = useCells(archiveFilter);
  // The poll keeps each cell's content fresh every 2s, but re-sorting the list
  // on every poll makes rows jump around while you're reading them. Throttle
  // the *ordering* to a 10s cadence; content still updates underneath.
  const orderedCells = useThrottledOrdering(cells);
  const { archive, restore, remove, error: cleanupError } =
    useCellCleanup(refreshCells);
  const { tasks, refresh: refreshTasks } = useTasks();
  const { graders, graderConfigs, refresh: refreshGraderData } = useGraders();
  const [section, setSection] = useState<DashboardSection>("launch");
  const [selectedTaskName, setSelectedTaskName] = useState<string | null>(null);
  const [selectedId, select] = useHashSelection();
  const { events, retryError } = useCellEvents(selectedId);
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

  useEffect(() => {
    if (section !== "launch") return;
    if (selectedId === null && cells.length > 0) {
      select(cells[0]!.cell_id);
    }
  }, [cells, select, section, selectedId]);

  function switchToLaunch(taskName?: string) {
    if (taskName !== undefined) {
      setSelectedTaskName(taskName);
    }
    setSection("launch");
  }

  return (
    <div className="flex min-h-screen flex-col bg-stone-100 text-stone-950">
      <header className="border-b border-stone-200 bg-white/90 px-4 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-400">
              Oakridge dashboard
            </div>
            <h1 className="text-2xl font-semibold text-stone-950">
              Launch, Tasks, and Graders
            </h1>
            <p className="text-sm text-stone-500">
              Inspect the task catalog, manage inert local grader JSON, and launch runs from one surface.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {SECTION_LABELS.map((entry) => (
              <TabButton
                key={entry.key}
                label={entry.label}
                selected={section === entry.key}
                onClick={() => setSection(entry.key)}
              />
            ))}
          </div>
        </div>
      </header>

      {section === "launch" ? (
        <section className="flex flex-1 flex-col overflow-hidden">
          <section className="shrink-0 border-b border-stone-200 bg-white">
            <h2 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-stone-400">
              Launch
            </h2>
            <LaunchForm
              tasks={tasks}
              selectedTaskName={selectedTaskName}
              onSelectTask={setSelectedTaskName}
            />
            <ActiveRunsStrip />
          </section>
          {cleanupError !== null && (
            <div className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 text-[12px] text-red-700">
              Cleanup error: {cleanupError}
            </div>
          )}
          {retryError !== null && (
            <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] text-amber-800">
              Cell stream: {retryError}
            </div>
          )}
          <div className="flex flex-1 overflow-hidden">
            <CellList
              cells={orderedCells}
              selectedId={selectedId}
              onSelect={select}
              filter={archiveFilter}
              onFilterChange={setArchiveFilter}
              onArchive={archive}
              onRestore={restore}
              onDelete={remove}
            />
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
        </section>
      ) : section === "tasks" ? (
        <TasksSection
          tasks={tasks}
          selectedTaskName={selectedTaskName}
          onSelectTask={setSelectedTaskName}
          onCreateTask={(taskName) => switchToLaunch(taskName)}
          onRefreshTasks={refreshTasks}
          graders={graders}
          graderConfigs={graderConfigs}
        />
      ) : (
        <GradersSection
          tasks={tasks}
          selectedTaskName={selectedTaskName}
          onSelectTask={setSelectedTaskName}
          graders={graders}
          graderConfigs={graderConfigs}
          onRefreshGraderData={refreshGraderData}
        />
      )}
    </div>
  );
}

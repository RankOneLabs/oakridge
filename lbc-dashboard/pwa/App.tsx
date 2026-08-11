/**
 * Top-level dashboard orchestrator.
 *
 * Launch remains the default section. Tasks and Graders are first-class
 * top-level sections that reuse the same task catalog and task selection
 * state so a newly created task can be launched immediately.
 */
import { useEffect, useRef, useState } from "react";

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
import {
  readStoredTheme,
  writeStoredTheme,
  type DashboardTheme,
} from "./lib/themeStorage";

type DashboardSection = "launch" | "tasks" | "graders";

interface InitialThemeSelection {
  theme: DashboardTheme;
  canPersist: boolean;
}

function initialTheme(): InitialThemeSelection {
  const storedTheme = readStoredTheme(window.localStorage);
  if (storedTheme.ok && storedTheme.value !== null) {
    return { theme: storedTheme.value, canPersist: true };
  }
  return {
    theme: window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
    canPersist: storedTheme.ok,
  };
}

const SECTION_LABELS: Array<{ key: DashboardSection; label: string }> = [
  { key: "launch", label: "Launch" },
  { key: "tasks", label: "Tasks" },
  { key: "graders", label: "Graders" },
];

export function App() {
  const [initialThemeSelection] = useState<InitialThemeSelection>(initialTheme);
  const [theme, setTheme] = useState<DashboardTheme>(initialThemeSelection.theme);
  const canPersistTheme = useRef(initialThemeSelection.canPersist);
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
    document.documentElement.dataset.theme = theme;
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0c100f" : "#f1f4ef");
    if (canPersistTheme.current) {
      const result = writeStoredTheme(window.localStorage, theme);
      if (!result.ok) canPersistTheme.current = false;
    }
  }, [theme]);

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
    <div className="dashboard-shell flex min-h-screen flex-col bg-stone-100 text-stone-950">
      <header className="dashboard-header border-b border-stone-200 bg-white/90 px-5 backdrop-blur">
        <div className="mx-auto flex min-h-20 max-w-[1600px] flex-wrap items-center justify-between gap-5">
          <div className="flex items-center gap-4">
            <div className="brand-mark" aria-hidden="true">L</div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-emerald-600">
                Oakridge research operations
              </div>
              <h1 className="text-xl font-semibold tracking-tight text-stone-950">
                Legit Biz Club
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <nav className="flex flex-wrap gap-5" aria-label="Dashboard sections">
              {SECTION_LABELS.map((entry) => (
                <TabButton
                  key={entry.key}
                  label={entry.label}
                  selected={section === entry.key}
                  onClick={() => setSection(entry.key)}
                />
              ))}
            </nav>
            <button
              type="button"
              className="theme-switch"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
        </div>
      </header>

      {section === "launch" ? (
        <section className="flex flex-1 flex-col overflow-hidden">
          <section className="launch-workspace shrink-0 border-b border-stone-200 bg-white">
            <div className="mx-auto max-w-[1600px] px-5 pt-8">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-600">New study</p>
              <h2 className="mt-1 text-3xl font-medium tracking-[-0.04em] text-stone-950">Configure and launch a run.</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500">Choose the task, model cohort, and collaboration condition. Active studies remain visible below.</p>
            </div>
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

import { paneSelectionClass, paneSelectionName, selectPaneSlots } from "../../lib/pane-selection";
import { useState, type ComponentProps } from "react";
import { Button } from "../../../components/atoms/Button";
import type { ArtifactId } from "../../../lib/ids";
import type { RunArtifactRef, RunSidebarSessionsView } from "../../lib/run-overview";
import { selectFilteredRunArtifacts, type RunArtifactFilter } from "../../lib/artifact-filter";
import {
  GRADING_PANE,
  LIST_PANE,
  OVERVIEW_PANE,
  arePanesEqual,
  isTwinView,
  type RunWorkspacePane,
  type RunWorkspaceSlot,
  type RunWorkspaceState,
} from "../../lib/run-workspace";
import { RunSidebarArtifacts } from "./RunSidebarArtifacts";
import { RunSidebarSessions } from "./RunSidebarSessions";

interface RunWorkspaceSidebarProps {
  hideEnded: ComponentProps<typeof RunSidebarSessions>["hideEnded"];
  renderRow: ComponentProps<typeof RunSidebarSessions>["renderRow"];
  isOpen: boolean;
  workspace: RunWorkspaceState;
  sessions: RunSidebarSessionsView;
  artifacts: readonly RunArtifactRef[];
  onOpenPane: (pane: RunWorkspacePane, slot: RunWorkspaceSlot) => void;
  onCollapse: () => void;
}

interface PaneShortcut {
  readonly pane: RunWorkspacePane;
  readonly label: string;
  readonly testId: string;
}

const PANE_SHORTCUTS: readonly PaneShortcut[] = [
  { pane: OVERVIEW_PANE, label: "Overview", testId: "or-sidebar-pane-overview" },
  { pane: LIST_PANE, label: "Stages", testId: "or-sidebar-pane-list" },
  { pane: GRADING_PANE, label: "Grading", testId: "or-sidebar-pane-grading" },
];

/**
 * The run's persistent navigation: the two run-derived panes, then every
 * session and every artifact.
 *
 * Neither fetches nor
 * owns domain state — rows arrive derived and the workspace state is the pane
 * host's. Hiding it below the breakpoint is a CSS concern; `isOpen` only marks
 * which state the toggle is in.
 */
export function RunWorkspaceSidebar({
  hideEnded,
  renderRow,
  isOpen,
  workspace,
  sessions,
  artifacts,
  onOpenPane,
  onCollapse,
}: RunWorkspaceSidebarProps) {
  const [artifactFilter, setArtifactFilter] = useState<RunArtifactFilter>("all");

  const visibleArtifacts = selectFilteredRunArtifacts(artifacts, artifactFilter);
  const openArtifact = (artifactId: ArtifactId, slot: RunWorkspaceSlot) =>
    onOpenPane({ kind: "artifact", artifact_id: artifactId }, slot);

  return (
    <aside
      className={`or-run-workspace__sidebar ${isOpen ? "or-run-workspace__sidebar--open" : ""}`}
      aria-label="Run navigation"
      data-testid="or-run-sidebar"
    >
      <section className="or-run-sidebar__section">
        <h3 className="or-run-sidebar__heading">Panes</h3>
        <ul className="or-run-sidebar__list">
          {PANE_SHORTCUTS.map((shortcut) => (
            <li key={shortcut.testId} className="or-run-sidebar__row">
              <Button variant="sidebar-row"
                type="button"
                className={paneSelectionClass(selectPaneSlots(workspace, (pane) => arePanesEqual(pane, shortcut.pane)))}
                data-pane-selection={paneSelectionName(selectPaneSlots(workspace, (pane) => arePanesEqual(pane, shortcut.pane)))}
                onClick={() => onOpenPane(shortcut.pane, "primary")}
                data-testid={shortcut.testId}
              >
                <span className="or-run-sidebar__row-title">{shortcut.label}</span>
              </Button>
              <Button variant="secondary"
                type="button"
                className="or-run-sidebar__row-twin"
                onClick={() => onOpenPane(shortcut.pane, "secondary")}
                aria-label={`Open ${shortcut.label} in the second pane`}
                data-testid={`${shortcut.testId}-twin`}
              >
                ⧉
              </Button>
            </li>
          ))}
        </ul>
        {isTwinView(workspace) && (
          <Button variant="secondary"
            type="button"
            className="or-run-sidebar__collapse"
            onClick={onCollapse}
            data-testid="or-sidebar-collapse"
          >
            Collapse to one pane
          </Button>
        )}
      </section>

      <RunSidebarSessions
        hideEnded={hideEnded}
        rows={sessions.rows}
        isActionStateKnown={sessions.is_action_state_known}
        isSessionListKnown={sessions.is_session_list_known}
        slotsOf={(id) => selectPaneSlots(workspace, (pane) => pane.kind === "session" && pane.session_id === id)}
        renderRow={renderRow}
      />
      <RunSidebarArtifacts rows={visibleArtifacts} totalCount={artifacts.length} filter={artifactFilter}
        onFilterChange={setArtifactFilter}
        slotsOf={(id) => selectPaneSlots(workspace, (pane) => pane.kind === "artifact" && pane.artifact_id === id)} onOpen={openArtifact} />
    </aside>
  );
}

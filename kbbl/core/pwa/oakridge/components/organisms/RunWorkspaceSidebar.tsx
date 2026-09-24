import type { ArtifactId, Sid } from "../../../lib/ids";
import type { RunArtifactRef, RunSidebarSessionRow } from "../../lib/run-overview";
import {
  LIST_PANE,
  OVERVIEW_PANE,
  arePanesEqual,
  isTwinView,
  selectOpenEntityIds,
  type RunWorkspacePane,
  type RunWorkspaceSlot,
  type RunWorkspaceState,
} from "../../lib/run-workspace";
import { RunSidebarArtifacts } from "../molecules/RunSidebarArtifacts";
import { RunSidebarSessions } from "../molecules/RunSidebarSessions";

interface RunWorkspaceSidebarProps {
  isOpen: boolean;
  workspace: RunWorkspaceState;
  sessions: readonly RunSidebarSessionRow[];
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
];

/**
 * The run's persistent navigation: the two run-derived panes, then every
 * session and every artifact.
 *
 * Filed under organisms/ as the cohort decided, though it neither fetches nor
 * owns domain state — rows arrive derived and the workspace state is the pane
 * host's. Hiding it below the breakpoint is a CSS concern; `isOpen` only marks
 * which state the toggle is in.
 */
export function RunWorkspaceSidebar({
  isOpen,
  workspace,
  sessions,
  artifacts,
  onOpenPane,
  onCollapse,
}: RunWorkspaceSidebarProps) {
  const open = selectOpenEntityIds(workspace);
  const openSession = (sessionId: Sid, slot: RunWorkspaceSlot) =>
    onOpenPane({ kind: "session", session_id: sessionId }, slot);
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
              <button
                type="button"
                className={`or-run-sidebar__row-open ${
                  arePanesEqual(workspace.primary, shortcut.pane) ||
                  arePanesEqual(workspace.secondary, shortcut.pane)
                    ? "or-run-sidebar__row-open--active"
                    : ""
                }`}
                onClick={() => onOpenPane(shortcut.pane, "primary")}
                data-testid={shortcut.testId}
              >
                <span className="or-run-sidebar__row-title">{shortcut.label}</span>
              </button>
              <button
                type="button"
                className="or-run-sidebar__row-twin"
                onClick={() => onOpenPane(shortcut.pane, "secondary")}
                aria-label={`Open ${shortcut.label} in the second pane`}
                data-testid={`${shortcut.testId}-twin`}
              >
                ⧉
              </button>
            </li>
          ))}
        </ul>
        {isTwinView(workspace) && (
          <button
            type="button"
            className="or-run-sidebar__collapse"
            onClick={onCollapse}
            data-testid="or-sidebar-collapse"
          >
            Collapse to one pane
          </button>
        )}
      </section>

      <RunSidebarSessions rows={sessions} openSessionIds={open.session_ids} onOpen={openSession} />
      <RunSidebarArtifacts rows={artifacts} openArtifactIds={open.artifact_ids} onOpen={openArtifact} />
    </aside>
  );
}

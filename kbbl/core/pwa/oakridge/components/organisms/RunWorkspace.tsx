import { useState } from "react";

import { useRun } from "../../hooks/useRun";
import { useRunGates } from "../../hooks/useRunGates";
import { useRunSessions } from "../../hooks/useRunSessions";
import { useRunWorkspaceState } from "../../hooks/useRunWorkspaceState";
import { selectRunAccentClass } from "../../lib/run-accent";
import {
  selectRunArtifacts,
  selectRunGatesRead,
  selectRunOverview,
  selectRunSidebarSessions,
  type RunOverview,
} from "../../lib/run-overview";
import {
  canMoveToOtherSlot,
  describePane,
  isTwinView,
  type RoutePaneTarget,
  type RunWorkspacePane,
  type RunWorkspaceSlot,
} from "../../lib/run-workspace";
import type { ArtifactId, Sid } from "../../../lib/ids";
import { useStore } from "../../../state/store";
import { RunIdentityHeader } from "../molecules/RunIdentityHeader";
import { RunPaneChrome } from "../molecules/RunPaneChrome";
import { ArtifactReview } from "./ArtifactReview";
import { RunOverviewPane } from "./RunOverviewPane";
import { RunSessionPane } from "./RunSessionPane";
import { RunWorkspaceSidebar } from "./RunWorkspaceSidebar";
import { RunDetail } from "./RunDetail";

interface RunWorkspaceProps {
  runId: string;
  routePane: RoutePaneTarget | null;
  onBack: () => void;
}

/**
 * The run command center: identity header, persistent sidebar, and a workspace
 * of one or two panes.
 *
 * This is the only component here that reads — `useRun`, `useRunGates` and
 * `useRunSessions` — and the only one that owns workspace state. Everything
 * below it takes derived values as props.
 */
export function RunWorkspace({ runId, routePane, onBack }: RunWorkspaceProps) {
  const runQuery = useRun(runId);
  const gatesQuery = useRunGates(runId);
  const sessionsQuery = useRunSessions(runId);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const run = runQuery.data;
  // `data` is undefined both while the sessions read is in flight and after it
  // fails, and restore waits on undefined — so a failed read would hold the
  // workspace on "Loading run…" forever. `isPending` is what actually separates
  // "still loading" from "there is no list": once the query has settled, an
  // absent list is an empty one, and the run opens on its stored arrangement.
  const sessions = sessionsQuery.isPending ? undefined : (sessionsQuery.data ?? []);
  // The inbox's record of what has been purged server-side. Oakridge keeps
  // listing the work order behind a purged session, so this is the only signal
  // that a pane holding one is showing a transcript that no longer exists.
  const purgedSessionIds = useStore((state) => state.removedSids);
  const workspace = useRunWorkspaceState({ runId, routePane, run, sessions, purgedSessionIds });

  if (runQuery.isError) {
    return (
      <div className="or-page or-page--wide" data-testid="or-run-workspace-error">
        <div
          className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]"
          role="alert"
        >
          {runQuery.error instanceof Error ? runQuery.error.message : "Failed to load run"}
        </div>
      </div>
    );
  }

  if (run === undefined || workspace.state === null) {
    return (
      <div className="or-page or-page--wide" data-testid="or-run-workspace-loading">
        <div className="py-6 text-sm text-[var(--text-muted)]">Loading run…</div>
      </div>
    );
  }

  const state = workspace.state;
  // A gate read that never landed is not an empty gate list — `selectRunGatesRead`
  // keeps the two apart so neither surface can render an outage as "nothing needs you".
  const gates = selectRunGatesRead({
    gates: gatesQuery.data,
    is_pending: gatesQuery.isPending,
    is_error: gatesQuery.isError,
  });
  const sessionRows = sessions ?? [];
  const overview = selectRunOverview({ run, sessions: sessionRows, gates });
  const sidebarSessions = selectRunSidebarSessions({
    sessions: sessionRows,
    gates,
    purgedSessionIds,
  });
  const sidebarArtifacts = selectRunArtifacts(run);

  const renderPane = (slot: RunWorkspaceSlot, pane: RunWorkspacePane) => {
    const heading = describePane(pane);
    return (
      <RunPaneChrome
        slot={slot}
        title={heading.title}
        subtitle={heading.subtitle}
        actions={{
          onOpenInOtherPane: canMoveToOtherSlot(state, slot)
            ? () => workspace.moveSlot(slot)
            : null,
          onClose: () => workspace.closeSlot(slot),
        }}
      >
        <PaneBody
          pane={pane}
          runId={runId}
          onBack={onBack}
          onOpenPane={(next) => workspace.openPane(next, slot)}
          overview={overview}
        />
      </RunPaneChrome>
    );
  };

  return (
    <div
      className={`or-run-workspace ${selectRunAccentClass(runId)}`}
      data-testid="or-run-workspace"
    >
      <RunIdentityHeader
        run={run}
        accentClass={selectRunAccentClass(runId)}
        isSidebarOpen={isSidebarOpen}
        onToggleSidebar={() => setIsSidebarOpen((open) => !open)}
        onBack={onBack}
      />
      <div className="or-run-workspace__body">
        <RunWorkspaceSidebar
          isOpen={isSidebarOpen}
          workspace={state}
          sessions={sidebarSessions}
          artifacts={sidebarArtifacts}
          onOpenPane={(pane, slot) => workspace.openPane(pane, slot)}
          onCollapse={workspace.collapse}
        />
        <div
          className={`or-run-workspace__panes ${isTwinView(state) ? "or-run-workspace__panes--twin" : ""}`}
          data-testid="or-run-panes"
          data-twin={isTwinView(state)}
        >
          {renderPane("primary", state.primary)}
          {state.secondary !== null && renderPane("secondary", state.secondary)}
        </div>
      </div>
    </div>
  );
}

interface PaneBodyProps {
  pane: RunWorkspacePane;
  runId: string;
  overview: RunOverview;
  onBack: () => void;
  onOpenPane: (pane: RunWorkspacePane) => void;
}

/**
 * What each pane variant renders.
 *
 * Every variant mounts an existing organism rather than a pane-local copy of
 * one: the list pane `RunDetail`, the artifact pane `ArtifactReview` with its
 * descriptor-driven viewer, review items, threads and gate decisions intact,
 * and the session pane `SessionView` through `RunSessionPane`. Both entity
 * renderers keep owning their own fetching — lifting their queries up here
 * would give one renderer two fetching paths, which is the duplication reuse
 * was meant to avoid.
 */
function PaneBody({ pane, runId, overview, onBack, onOpenPane }: PaneBodyProps) {
  switch (pane.kind) {
    case "overview":
      return <RunOverviewPane overview={overview} onOpenPane={onOpenPane} />;
    case "list":
      return (
        <RunDetail
          runId={runId}
          onBack={onBack}
          onSelectArtifact={(artifactId) =>
            onOpenPane({ kind: "artifact", artifact_id: artifactId as ArtifactId })
          }
        />
      );
    case "artifact":
      return <ArtifactReview artifactId={pane.artifact_id} />;
    case "session":
      return (
        <RunSessionPane
          sessionId={pane.session_id}
          onOpenSession={(sessionId: Sid) =>
            onOpenPane({ kind: "session", session_id: sessionId })
          }
        />
      );
  }
}

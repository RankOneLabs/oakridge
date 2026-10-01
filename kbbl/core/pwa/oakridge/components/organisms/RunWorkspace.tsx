import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useRunDiagnosis } from "../../hooks/useRunDiagnosis";
import { useRunWorkspaceState } from "../../hooks/useRunWorkspaceState";
import { selectRunAccentClass } from "../../lib/run-accent";
import { selectPurgedRunSessionIds, type RunSessionsRead } from "../../lib/run-sessions";
import {
  selectRunArtifacts,
  selectRunSidebarSessions,
  type RunOverview,
} from "../../lib/run-overview";
import {
  canMoveToOtherSlot,
  describePane,
  isTwinView,
  shouldReadRunActivity,
  type RoutePaneTarget,
  type RunWorkspacePane,
  type RunWorkspaceSlot,
} from "../../lib/run-workspace";
import type { ArtifactId, Sid } from "../../../lib/ids";
import type { RunDetail as RunDetailRecord } from "../../types";
import { useStore } from "../../../state/store";
import { RunIdentityHeader } from "../molecules/RunIdentityHeader";
import { RunPaneChrome } from "../molecules/RunPaneChrome";
import { ArtifactReview } from "./ArtifactReview";
import { RunOverviewPane } from "./RunOverviewPane";
import { RunSessionPane } from "./RunSessionPane";
import { RunWorkspaceSidebar } from "./RunWorkspaceSidebar";
import { RunDetail } from "./RunDetail";
import { fetchRunEvents, selectRunActivity, type RunActivityRead } from "../../lib/run-activity";

interface RunWorkspaceProps {
  runId: string;
  routePane: RoutePaneTarget | null;
  onBack: () => void;
}

/**
 * The run command center: identity header, persistent sidebar, and a workspace
 * of one or two panes.
 *
 * This is the only component here that reads the run diagnosis and owns
 * workspace state. Everything below it receives committed facts as props.
 */
export function RunWorkspace({ runId, routePane, onBack }: RunWorkspaceProps) {
  const diagnosisQuery = useRunDiagnosis(runId);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const diagnosis = diagnosisQuery.data;
  const run = diagnosis?.run;
  const sessions: RunSessionsRead = diagnosis
    ? { kind: "loaded", sessions: diagnosis.sessions }
    : diagnosisQuery.isError ? { kind: "unavailable" } : { kind: "pending" };
  const inventorySessions = useStore((state) => state.sessions);
  const hasInboxSnapshot = useStore((state) => state.hasInboxSnapshot);
  const hasSessionSeed = useStore((state) => state.hasSessionSeed);
  const removedSids = useStore((state) => state.removedSids);
  const purgedSessionIds = selectPurgedRunSessionIds({
    run,
    sessions,
    inventory: { sessions: inventorySessions, hasInboxSnapshot, hasSessionSeed, removedSids },
  });
  const workspace = useRunWorkspaceState({ runId, routePane, run, sessions, purgedSessionIds });
  const activityQuery = useQuery({
    queryKey: ["oakridge", "run", runId, "activity"],
    queryFn: () => fetchRunEvents(runId),
    enabled: workspace.state !== null && shouldReadRunActivity(workspace.state),
    refetchInterval: 10_000,
  });

  if (diagnosisQuery.isError) {
    return (
      <div className="or-page or-page--wide" data-testid="or-run-workspace-error">
        <div
          className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger-fg)]"
          role="alert"
        >
          {diagnosisQuery.error instanceof Error ? diagnosisQuery.error.message : "Failed to load run"}
        </div>
      </div>
    );
  }

  if (diagnosis === undefined || run === undefined || workspace.state === null) {
    return (
      <div className="or-page or-page--wide" data-testid="or-run-workspace-loading">
        <div className="py-6 text-sm text-[var(--text-muted)]">Loading run…</div>
      </div>
    );
  }

  const state = workspace.state;
  const overview = diagnosis;
  const sidebarSessions = selectRunSidebarSessions(diagnosis, purgedSessionIds);
  const sidebarArtifacts = selectRunArtifacts(run);
  const activity: RunActivityRead = activityQuery.data !== undefined
    ? { kind: "loaded", items: selectRunActivity(activityQuery.data, run) }
    : activityQuery.isError && !activityQuery.isPending
      ? { kind: "unavailable" }
      : { kind: "pending" };

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
          run={run}
          onRunDeleted={onBack}
          onOpenPane={(next) => workspace.openPane(next, slot)}
          overview={overview}
          activity={activity}
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
  run: RunDetailRecord;
  overview: RunOverview;
  activity: RunActivityRead;
  /** Leave the run because it was deleted from inside the list pane. */
  onRunDeleted: () => void;
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
function PaneBody({ pane, runId, run, overview, activity, onRunDeleted, onOpenPane }: PaneBodyProps) {
  switch (pane.kind) {
    case "overview":
      return <RunOverviewPane overview={overview} activity={activity} onOpenPane={onOpenPane} />;
    case "list":
      return (
        <RunDetail
          runId={runId}
          run={run}
          activeGates={overview.active_gates}
          mergeWaits={overview.pull_request_merge_waits}
          onRunDeleted={onRunDeleted}
          onSelectArtifact={(artifactId) =>
            onOpenPane({ kind: "artifact", artifact_id: artifactId as ArtifactId })
          }
        />
      );
    case "artifact":
      return <ArtifactReview artifactId={pane.artifact_id} gates={overview.active_gates} />;
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

import { useOakridgeConfig } from "./hooks/useOakridgeConfig";
import { RunListView } from "./views/RunListView";
import { RunDetailView } from "./views/RunDetailView";
import { ArtifactWorkspaceRedirectView } from "./views/ArtifactWorkspaceRedirectView";
import { NewRunView } from "./views/NewRunView";
import { CreateProjectView } from "./views/CreateProjectView";
import { WorkflowDefListView } from "./views/WorkflowDefListView";
import { WorkflowDefEditorView } from "./views/WorkflowDefEditorView";
import { WorkflowDefDetailView } from "./views/WorkflowDefDetailView";
import { ReviewInboxView } from "./views/ReviewInboxView";
import { SessionWorkspaceRedirectView } from "./views/SessionWorkspaceRedirectView";
import { formatRunWorkspaceHash, type OakridgeSubRoute } from "../lib/hash";
import type { ArtifactId } from "../lib/ids";
import type { WorkflowDefSummary } from "./types";
interface OakridgeShellInnerProps {
  route: OakridgeSubRoute;
  runAttentionCounts: ReadonlyMap<string, number>;
  onNavigate: (hash: string) => void;
}

function OakridgeShellInner({ route, runAttentionCounts, onNavigate }: OakridgeShellInnerProps) {
  const configQuery = useOakridgeConfig();

  // Show loading while the availability check is in flight
  if (configQuery.isPending) {
    return (
      <div className="or-shell" data-testid="or-shell">
        <div className="or-loading">Connecting to oakridge…</div>
      </div>
    );
  }

  // Show unavailable state when the retained OAKRIDGE_CORE_BASE_URL setting is unset.
  if (!configQuery.data?.available) {
    return (
      <div className="or-shell" data-testid="or-shell">
        <div className="or-unavailable" data-testid="or-unavailable">
          <h2>Oakridge backend not configured</h2>
          <p>
            Set <code>OAKRIDGE_CORE_BASE_URL</code> on the kbbl server to enable
            workflow run inspection.
          </p>
        </div>
      </div>
    );
  }

  const navigateToRun = (id: string) => onNavigate(formatRunWorkspaceHash(id, null));
  const navigateToArtifact = (id: string) => onNavigate(`oakridge/artifact/${encodeURIComponent(id)}`);
  const navigateToRuns = () => onNavigate("oakridge");
  const navigateToNewRun = () => onNavigate("oakridge/new-run");
  const navigateToReviewInbox = () => onNavigate("oakridge/review-inbox");
  const navigateToCreateProject = () => onNavigate("oakridge/create-project");
  const navigateToDefs = () => onNavigate("oakridge/defs");
  const navigateToDef = (id: string) => onNavigate(`oakridge/def/${encodeURIComponent(id)}`);
  const navigateToDefNew = () => onNavigate("oakridge/def-new");
  const navigateToDefEdit = (id: string) => onNavigate(`oakridge/def-edit/${encodeURIComponent(id)}`);

  let content: React.ReactNode;
  switch (route.sub) {
    case "runs":
      content = (
        <RunListView
          onSelectRun={navigateToRun}
          onNewRun={navigateToNewRun}
          onNewProject={navigateToCreateProject}
          onReviewInbox={navigateToReviewInbox}
          onSelectArtifact={navigateToArtifact}
          runAttentionCounts={runAttentionCounts}
        />
      );
      break;
    case "review-inbox":
      content = (
        <ReviewInboxView
          onSelectRun={navigateToRun}
          onSelectArtifact={navigateToArtifact}
        />
      );
      break;
    case "run":
      content = (
        <RunDetailView runId={route.id} routePane={route.pane} onBack={navigateToRuns} />
      );
      break;
    case "session":
      content = (
        <SessionWorkspaceRedirectView sessionId={route.session_id} onBack={navigateToRuns} />
      );
      break;
    case "artifact":
      content = (
        <ArtifactWorkspaceRedirectView
          artifactId={route.id as ArtifactId}
          onBack={navigateToRuns}
        />
      );
      break;
    case "new-run":
      content = (
        <NewRunView
          onBack={navigateToRuns}
          onCreated={(id) => navigateToRun(id)}
        />
      );
      break;
    case "create-project":
      content = (
        <CreateProjectView
          onBack={navigateToRuns}
          onCreated={navigateToRuns}
        />
      );
      break;
    case "defs":
      content = (
        <WorkflowDefListView
          onNew={navigateToDefNew}
          onSelect={(def: WorkflowDefSummary) => navigateToDef(def.id)}
          onClone={(def: WorkflowDefSummary) => navigateToDefEdit(def.id)}
        />
      );
      break;
    case "def":
      content = (
        <WorkflowDefDetailView
          definitionId={route.id}
          onBack={navigateToDefs}
          onClone={() => navigateToDefEdit(route.id)}
        />
      );
      break;
    case "def-new":
      content = (
        <WorkflowDefEditorView
          key="new"
          cloneFromId={null}
          onBack={navigateToDefs}
          onCreated={navigateToDefs}
        />
      );
      break;
    case "def-edit":
      content = (
        <WorkflowDefEditorView
          key={route.id}
          cloneFromId={route.id}
          onBack={navigateToDefs}
          onCreated={navigateToDefs}
        />
      );
      break;
  }

  return (
    <div className="or-shell" data-testid="or-shell">
      <main className="or-shell__content">
        {content}
      </main>
    </div>
  );
}

interface OakridgeShellProps {
  route: OakridgeSubRoute;
  runAttentionCounts?: ReadonlyMap<string, number>;
  /** Retained for embedders compiled against the prior shell API; peer navigation owns routing now. */
  onBack?: () => void;
}

export function OakridgeShell({ route, runAttentionCounts = new Map() }: OakridgeShellProps) {
  const onNavigate = (hash: string) => {
    window.location.hash = hash;
  };

  return <OakridgeShellInner route={route} runAttentionCounts={runAttentionCounts} onNavigate={onNavigate} />;
}

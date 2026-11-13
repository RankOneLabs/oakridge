import { Button } from "../components/atoms/Button";
import { GradingConfigView } from "./views/GradingConfigView";
import { useOakridgeConfig } from "./hooks/useOakridgeConfig";
import { RunListView } from "./views/RunListView";
import { RunDetailView } from "./views/RunDetailView";
import { ArtifactWorkspaceRedirectView } from "./views/ArtifactWorkspaceRedirectView";
import { NewRunView } from "./views/NewRunView";
import { CreateProjectView } from "./views/CreateProjectView";
import { WorkflowDefListView } from "./views/WorkflowDefListView";
import { WorkflowDefDetailView } from "./views/WorkflowDefDetailView";
import { ReviewInboxView } from "./views/ReviewInboxView";
import { SessionWorkspaceRedirectView } from "./views/SessionWorkspaceRedirectView";
import { formatRunWorkspaceHash, type OakridgeSubRoute } from "../lib/hash";
import type { ArtifactId } from "../lib/ids";
import type { WorkflowDefSummary } from "./project-types";
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
  const navigateToCreateProject = () => onNavigate("oakridge/create-project");
  const navigateToDefs = () => onNavigate("oakridge/defs");
  const navigateToDef = (id: string) => onNavigate(`oakridge/def/${encodeURIComponent(id)}`);

  let content: React.ReactNode;
  switch (route.sub) {
    case "runs":
      content = (
        <RunListView
          onSelectRun={navigateToRun}
          onNewRun={navigateToNewRun}
          onNewProject={navigateToCreateProject}
          onWorkflows={navigateToDefs}
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
    case "grading-config":
      content = <GradingConfigView version={route.version} onNavigate={(version) => onNavigate(version === null ? "/oakridge/grading-config" : `/oakridge/grading-config/versions/${version}`)} />;
      break;
    case "defs":
      content = (
        <WorkflowDefListView
          onSelect={(def: WorkflowDefSummary) => navigateToDef(def.id)}
        />
      );
      break;
    case "def":
      content = (
        <WorkflowDefDetailView
          definitionId={route.id}
          onBack={navigateToDefs}
        />
      );
      break;

  }

  return (
    <div className="or-shell" data-testid="or-shell">
      <nav aria-label="Oakridge" className="flex flex-wrap gap-2 p-3">
        <Button onClick={navigateToRuns}>Runs</Button>
        <Button onClick={navigateToDefs}>Workflows</Button>
        <Button onClick={() => onNavigate("/oakridge/grading-config")}>Grading configuration</Button>
      </nav>
      <main className="or-shell__content">
        {content}
      </main>
    </div>
  );
}

interface OakridgeShellProps {
  route: OakridgeSubRoute;
  runAttentionCounts?: ReadonlyMap<string, number>;
}

export function OakridgeShell({ route, runAttentionCounts = new Map() }: OakridgeShellProps) {
  const onNavigate = (hash: string) => {
    window.location.hash = hash;
  };

  return <OakridgeShellInner route={route} runAttentionCounts={runAttentionCounts} onNavigate={onNavigate} />;
}

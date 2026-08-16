import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useOakridgeConfig } from "./hooks/useOakridgeConfig";
import { RunListView } from "./views/RunListView";
import { RunDetailView } from "./views/RunDetailView";
import { ArtifactReviewView } from "./views/ArtifactReviewView";
import { NewRunView } from "./views/NewRunView";
import { CreateProjectView } from "./views/CreateProjectView";
import { WorkflowDefListView } from "./views/WorkflowDefListView";
import { WorkflowDefEditorView } from "./views/WorkflowDefEditorView";
import { WorkflowDefDetailView } from "./views/WorkflowDefDetailView";
import { ReviewInboxView } from "./views/ReviewInboxView";
import type { OakridgeSubRoute } from "../lib/hash";
import type { WorkflowDefSummary } from "./types";
import { useOakridgeInvalidationStream } from "./hooks/useOakridgeInvalidationStream";

// The oakridge shell gets its own QueryClient so it doesn't collide with the
// main app's client when mounted independently under the oakridge hash route.
// In practice both clients co-exist inside QueryClientProvider from main.tsx,
// but separating them keeps cache isolation simple.
interface OakridgeShellInnerProps {
  route: OakridgeSubRoute;
  onBack: () => void;
  onNavigate: (hash: string) => void;
}

function OakridgeShellInner({ route, onBack, onNavigate }: OakridgeShellInnerProps) {
  const configQuery = useOakridgeConfig();
  useOakridgeInvalidationStream(configQuery.data?.available === true);

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
        <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Back</button>
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

  const navigateToRun = (id: string) => onNavigate(`oakridge/run/${encodeURIComponent(id)}`);
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
        <RunDetailView
          runId={route.id}
          onBack={navigateToRuns}
          onSelectArtifact={navigateToArtifact}
        />
      );
      break;
    case "artifact":
      content = <ArtifactReviewView artifactId={route.id} onBack={navigateToRuns} />;
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
      <nav className="or-shell__nav">
        <button
          type="button"
          className="or-shell__back"
          onClick={onBack}
          aria-label="Back to kbbl"
        >
          ← kbbl
        </button>
        <span className="or-shell__brand"><i>O</i><span><strong>oakridge</strong><small>workflow operations</small></span></span>
        <button
          type="button"
          className={`or-shell__nav-item ${route.sub === "runs" ? "or-shell__nav-item--active" : ""}`}
          onClick={navigateToRuns}
        >
          Runs
        </button>
        <button
          type="button"
          className={`or-shell__nav-item ${route.sub === "review-inbox" ? "or-shell__nav-item--active" : ""}`}
          onClick={navigateToReviewInbox}
        >
          Review inbox
        </button>
        <button
          type="button"
          className={`or-shell__nav-item ${route.sub === "defs" || route.sub === "def" || route.sub === "def-new" || route.sub === "def-edit" ? "or-shell__nav-item--active" : ""}`}
          onClick={navigateToDefs}
        >
          Workflows
        </button>
      </nav>
      <main className="or-shell__content">
        {content}
      </main>
    </div>
  );
}

const shellQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

interface OakridgeShellProps {
  route: OakridgeSubRoute;
  onBack: () => void;
}

export function OakridgeShell({ route, onBack }: OakridgeShellProps) {
  const onNavigate = (hash: string) => {
    window.location.hash = hash;
  };

  return (
    <QueryClientProvider client={shellQueryClient}>
      <OakridgeShellInner route={route} onBack={onBack} onNavigate={onNavigate} />
    </QueryClientProvider>
  );
}

import { StatusView } from "./views/StatusView";
import { definitionHref } from "./lib/definition-selection";
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
import { formatRunWorkspaceHash, type SettingsSubRoute, type OakridgeSubRoute } from "../lib/hash";
import type { ArtifactId } from "../lib/ids";
import type { WorkflowDefSummary } from "./project-types";
type SettingsNavItem = "status" | "workflows" | "grading";
const SETTINGS_NAV: readonly { item: SettingsNavItem; href: string; label: string }[] = [
  { item: "status", href: "#settings/status", label: "Status" },
  { item: "workflows", href: "#settings/workflows", label: "Workflows" },
  { item: "grading", href: "#settings/workflows/grading-config", label: "Grading" },
];

/** The Settings sub-nav entry a route belongs to; null for routes outside Settings. */
function selectSettingsNavItem(route: OakridgeSubRoute | SettingsSubRoute): SettingsNavItem | null {
  switch (route.sub) {
    case "status": return "status";
    case "workflows":
    case "workflow": return "workflows";
    case "grading-config": return "grading";
    default: return null;
  }
}

interface OakridgeShellInnerProps {
  route: OakridgeSubRoute | SettingsSubRoute;
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
  const navigateToDefs = () => onNavigate("settings/workflows");
  const navigateToDef = (id: string) => onNavigate(definitionHref(id));

  let content: React.ReactNode;
  switch (route.sub) {
    case "status": content = <StatusView />; break;
    case "runs":
      content = (
        <RunListView
          onSelectRun={navigateToRun}
          onNewRun={navigateToNewRun}
          onNewProject={navigateToCreateProject}
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
      content = <GradingConfigView definitionId={route.definitionId} version={route.version} onNavigate={(version) => onNavigate(version === null ? "settings/workflows/grading-config" : `settings/workflows/grading-config/versions/${version}`)} />;
      break;
    case "workflows":
      content = (
        <WorkflowDefListView
          onSelect={(def: WorkflowDefSummary) => navigateToDef(def.id)}
        />
      );
      break;
    case "workflow":
      content = (
        <WorkflowDefDetailView
          definitionId={route.id}
          selection={route.selection}
          onNavigate={onNavigate}
          onBack={navigateToDefs}
        />
      );
      break;

  }

  const settingsItem = selectSettingsNavItem(route);
  return (
    <div className="or-shell" data-testid="or-shell">
      {settingsItem && <nav aria-label="Settings" className="flex flex-wrap gap-2 p-3">
        {SETTINGS_NAV.map(({ item, href, label }) => {
          const isCurrent = item === settingsItem;
          return <a key={item} href={href} className={isCurrent ? "or-shell__nav-item or-shell__nav-item--active" : "or-shell__nav-item"} aria-current={isCurrent ? "page" : undefined}>{label}</a>;
        })}
      </nav>}
      <main className="or-shell__content">
        {content}
      </main>
    </div>
  );
}

interface OakridgeShellProps {
  route: OakridgeSubRoute | SettingsSubRoute;
  runAttentionCounts?: ReadonlyMap<string, number>;
}

export function OakridgeShell({ route, runAttentionCounts = new Map() }: OakridgeShellProps) {
  const onNavigate = (hash: string) => {
    window.location.hash = hash;
  };

  return <OakridgeShellInner route={route} runAttentionCounts={runAttentionCounts} onNavigate={onNavigate} />;
}

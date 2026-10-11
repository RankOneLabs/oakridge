import { useOakridgeConfig } from "./hooks/useOakridgeConfig";
import { RunListView } from "./views/RunListView";
import { RunDetailView } from "./views/RunDetailView";
import { NewRunView } from "./views/NewRunView";
import { WorkflowDefListView } from "./views/WorkflowDefListView";
import { WorkflowDefDetailView } from "./views/WorkflowDefDetailView";
import { WorkflowDefEditorView } from "./views/WorkflowDefEditorView";
import { CreateProjectView } from "./views/CreateProjectView";
import { ReviewInboxView } from "./views/ReviewInboxView";
import { OperatorProjectsView } from "./views/OperatorProjectsView";
import { formatRunWorkspaceHash, type OakridgeSubRoute } from "../lib/hash";

interface Props { readonly route: OakridgeSubRoute }
export function OakridgeShell({ route }: Props) {
  const config = useOakridgeConfig();
  const navigate = (path: string) => { window.location.hash = path; };
  const runs = () => navigate("oakridge");
  const run = (id: string) => navigate(formatRunWorkspaceHash(id, null));
  const defs = () => navigate("oakridge/defs");
  let content: React.ReactNode;
  if (config.isPending) content = <p role="status">Connecting to Oakridge…</p>;
  else if (!config.data?.available) content = <p role="alert">Oakridge backend is unavailable.</p>;
  else switch (route.sub) {
    case "run": content = <RunDetailView runId={route.id} routePane={route.pane ?? null} scopeId={route.scope_id ?? null} onBack={runs} />; break;
    case "review-inbox": content = <ReviewInboxView onSelectScope={(runId, scopeId) => navigate(formatRunWorkspaceHash(runId, scopeId))} />; break;
    case "new-run": content = <NewRunView onBack={runs} onCreated={run} onEdit={() => navigate("oakridge/def-new")} />; break;
    case "create-project": content = <CreateProjectView onBack={runs} />; break;
    case "projects": content = <OperatorProjectsView onBack={runs} />; break;
    case "defs": content = <WorkflowDefListView onBack={runs} onNew={() => navigate("oakridge/def-new")}
      onSelect={(id) => navigate(`oakridge/def/${encodeURIComponent(id)}`)} onClone={(id) => navigate(`oakridge/def-edit/${encodeURIComponent(id)}`)} />; break;
    case "def": content = <WorkflowDefDetailView definitionId={route.id} onBack={defs} onClone={() => navigate(`oakridge/def-edit/${encodeURIComponent(route.id)}`)} />; break;
    case "def-new": content = <WorkflowDefEditorView cloneFromId={null} onBack={defs} onCreated={defs} />; break;
    case "def-edit": content = <WorkflowDefEditorView cloneFromId={route.id} onBack={defs} onCreated={defs} />; break;
    default: content = <RunListView onSelectRun={run} onNewRun={() => navigate("oakridge/new-run")} onDefinitions={defs} onProjects={() => navigate("oakridge/projects")} />;
  }
  return <div className="or-shell" data-testid="or-shell"><div className="or-shell__content">{content}</div></div>;
}

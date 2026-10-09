import { useOakridgeConfig } from "./hooks/useOakridgeConfig";
import { OperatorRunListView } from "./views/OperatorRunListView";
import { OperatorLaunchView } from "./views/OperatorLaunchView";
import { OperatorDefinitionsView } from "./views/OperatorDefinitionsView";
import { OperatorDefinitionEditorView } from "./views/OperatorDefinitionEditorView";
import { GenericOperatorRunView } from "./views/GenericOperatorRunView";
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
    case "run": content = <GenericOperatorRunView key={`${route.id}:${route.scope_id ?? ""}`} runId={route.id} initialScopeId={route.scope_id} onBack={runs} />; break;
    case "review-inbox": content = <ReviewInboxView onSelectScope={(runId, scopeId) => navigate(formatRunWorkspaceHash(runId, scopeId))} />; break;
    case "new-run": content = <OperatorLaunchView onBack={runs} onCreated={run} onEdit={() => navigate("oakridge/def-new")} />; break;
    case "projects": content = <OperatorProjectsView onBack={runs} />; break;
    case "defs": content = <OperatorDefinitionsView onBack={runs} onNew={() => navigate("oakridge/def-new")} onClone={(id) => navigate(`oakridge/def-edit/${encodeURIComponent(id)}`)} />; break;
    case "def-new": content = <OperatorDefinitionEditorView cloneFromId={null} onBack={defs} onPinned={defs} />; break;
    case "def-edit": content = <OperatorDefinitionEditorView cloneFromId={route.id} onBack={defs} onPinned={defs} />; break;
    default: content = <OperatorRunListView onSelectRun={run} onNewRun={() => navigate("oakridge/new-run")} onDefinitions={defs} onProjects={() => navigate("oakridge/projects")} />;
  }
  return <div className="or-shell" data-testid="or-shell"><div className="or-shell__content">{content}</div></div>;
}

import { useHashRoute } from "../../core/pwa/hooks/useHashRoute";
import { definitionHref } from "../../core/pwa/oakridge/lib/definition-selection";
import { WorkflowDefListView } from "../../core/pwa/oakridge/views/WorkflowDefListView";
import { WorkflowDefDetailView } from "../../core/pwa/oakridge/views/WorkflowDefDetailView";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewRunView } from "../../core/pwa/oakridge/views/NewRunView";
import { RunWorkspace } from "../../core/pwa/oakridge/components/organisms/RunWorkspace";

const container = document.getElementById("app");
if (!container) throw new Error("Browser fixture container missing");
const params = new URL(location.href).searchParams;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function DefinitionNavigation() {
  const route = useHashRoute();
  return route?.view === "settings" && route.route.sub === "workflow"
    ? <WorkflowDefDetailView definitionId={route.route.id} selection={route.route.selection} onBack={() => { location.hash = "#settings/workflows"; }} />
    : <WorkflowDefListView onSelect={definition => { location.hash = definitionHref(definition.id); }} />;
}
createRoot(container).render(<QueryClientProvider client={client}>
  {params.has("definitions") ? <DefinitionNavigation /> : params.has("launch")
    ? <NewRunView onBack={() => {}} onCreated={(runId) => { location.hash = `run/${runId}`; }} />
    : <RunWorkspace runId={params.get("run") ?? "run-1"} routePane={null} onBack={() => {}} />}
</QueryClientProvider>);

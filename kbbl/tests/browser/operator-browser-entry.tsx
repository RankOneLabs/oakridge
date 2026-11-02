import { useState } from "react";
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
  const [selected, setSelected] = useState<string | null>(null);
  return selected ? <WorkflowDefDetailView definitionId={selected} onBack={() => setSelected(null)} />
    : <WorkflowDefListView onSelect={(definition) => setSelected(definition.id)} />;
}
createRoot(container).render(<QueryClientProvider client={client}>
  {params.has("definitions") ? <DefinitionNavigation /> : params.has("launch")
    ? <NewRunView onBack={() => {}} onCreated={(runId) => { location.hash = `run/${runId}`; }} />
    : <RunWorkspace runId={params.get("run") ?? "run-1"} routePane={null} onBack={() => {}} />}
</QueryClientProvider>);

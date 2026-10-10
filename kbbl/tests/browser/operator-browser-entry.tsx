import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OperatorLaunchView } from "../../core/pwa/oakridge/views/OperatorLaunchView";
import { RunDetailView } from "../../core/pwa/oakridge/views/RunDetailView";

const container = document.getElementById("app");
if (!container) throw new Error("Browser fixture container missing");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(container).render(<QueryClientProvider client={client}>
  {new URL(location.href).searchParams.has("launch")
    ? <OperatorLaunchView onBack={() => {}} onEdit={() => {}} onCreated={(runId) => { location.hash = `run/${runId}`; }} />
    : <RunDetailView runId="run-1" routePane={null} scopeId={null} onBack={() => {}} />}
</QueryClientProvider>);

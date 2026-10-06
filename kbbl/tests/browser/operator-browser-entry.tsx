import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OperatorLaunchView } from "../../core/pwa/oakridge/views/OperatorLaunchView";
import { GenericOperatorRunView } from "../../core/pwa/oakridge/views/GenericOperatorRunView";

const container = document.getElementById("app");
if (!container) throw new Error("Browser fixture container missing");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(container).render(<QueryClientProvider client={client}>
  {new URL(location.href).searchParams.has("launch")
    ? <OperatorLaunchView onBack={() => {}} onEdit={() => {}} onCreated={(runId) => { location.hash = `run/${runId}`; }} />
    : <GenericOperatorRunView runId="run-1" onBack={() => {}} />}
</QueryClientProvider>);

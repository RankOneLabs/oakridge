import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GenericOperatorRunView } from "../../kbbl/core/pwa/oakridge/views/GenericOperatorRunView";

const container = document.getElementById("app");
if (!container) throw new Error("Browser fixture container missing");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(container).render(<QueryClientProvider client={client}>
  <GenericOperatorRunView runId="run-1" onBack={() => {}} />
</QueryClientProvider>);

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../../core/pwa/App";

const container = document.getElementById("app");
if (!container) throw new Error("Browser fixture container missing");
createRoot(container).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <App />
</QueryClientProvider>);

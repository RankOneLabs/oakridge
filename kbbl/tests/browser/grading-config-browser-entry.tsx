import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OakridgeShell } from "../../core/pwa/oakridge/OakridgeShell";
import { useHashRoute } from "../../core/pwa/hooks/useHashRoute";

function GradingNavigation() {
  const route = useHashRoute();
  return route?.view === "oakridge" ? <OakridgeShell route={route.route} /> : <p>Other view</p>;
}
const container = document.getElementById("app");
if (!container) throw new Error("Browser fixture container missing");
createRoot(container).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <GradingNavigation />
</QueryClientProvider>);

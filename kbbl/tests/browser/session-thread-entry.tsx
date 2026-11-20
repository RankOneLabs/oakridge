import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { PrimaryNav } from "../../core/pwa/components/molecules/PrimaryNav";
import { SessionView } from "../../core/pwa/views/SessionView";

const app = document.getElementById("app");
if (!app) throw new Error("missing app root");

createRoot(app).render(
  <QueryClientProvider client={new QueryClient()}>
    <PrimaryNav activeSurface="sessions" attentionCount={0} onNavigate={() => {}} theme="dark" onToggleTheme={() => {}} />
    <SessionView sid="paging" snapshot={null} inboxStatus="connected"
      chrome={{ kind: "route", onBack: () => {} }} onResume={async () => null} />
  </QueryClientProvider>,
);

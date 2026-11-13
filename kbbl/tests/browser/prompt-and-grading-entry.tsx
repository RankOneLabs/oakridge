import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PromptViewer } from "../../core/pwa/oakridge/components/organisms/PromptViewer";
import { ItemPanel } from "../../core/pwa/oakridge/components/organisms/ItemPanel";
import { IMPLEMENTATION } from "../../core/pwa/oakridge/__fixtures__/grading";

const container = document.getElementById("app");
if (!container) throw new Error("Browser fixture container missing");
const params = new URL(location.href).searchParams;
createRoot(container).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <main className="mx-auto max-w-3xl border-x border-[var(--border-decorative)] bg-[var(--bg-secondary)]">
    {params.has("prompt") ? <PromptViewer runId="run-1" unitId={params.get("unit") ?? ""} attemptId="recorded-attempt:1" />
      : <ItemPanel runId="run-1" selection={IMPLEMENTATION} onOpenTask={() => {}} />}
  </main>
</QueryClientProvider>);

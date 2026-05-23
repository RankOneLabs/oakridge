import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import "./styles.css";

// Module-level singleton so StrictMode's double-invoke doesn't construct two
// QueryClients and split the cache. Defaults tuned for the tablet-first PWA
// on Tailscale: window-focus refetch flicker is operator-hostile when
// switching apps; retry=1 keeps the UI responsive on localhost (3 retries =
// ~6s of dead UI on a single hung request); 30s staleTime matches median
// operator dwell-time so re-mounts don't gratuitously refetch.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
    },
  },
});

const rootEl = document.getElementById("app");
if (!rootEl) throw new Error("missing #app");
createRoot(rootEl).render(
  <QueryClientProvider client={queryClient}>
    <StrictMode>
      <App />
    </StrictMode>
  </QueryClientProvider>,
);

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useOakridgeConfig } from "./hooks";
import { RunListView } from "./RunListView";
import { RunDetailView } from "./RunDetailView";
import { ArtifactDetailView } from "./ArtifactDetailView";
import type { OakridgeSubRoute } from "../lib/hash";

// The oakridge shell gets its own QueryClient so it doesn't collide with the
// main app's client when mounted independently under the oakridge hash route.
// In practice both clients co-exist inside QueryClientProvider from main.tsx,
// but separating them keeps cache isolation simple.
interface OakridgeShellInnerProps {
  route: OakridgeSubRoute;
  onBack: () => void;
  onNavigate: (hash: string) => void;
}

function OakridgeShellInner({ route, onBack, onNavigate }: OakridgeShellInnerProps) {
  const configQuery = useOakridgeConfig();

  // Show loading while the availability check is in flight
  if (configQuery.isPending) {
    return (
      <div className="or-shell" data-testid="or-shell">
        <div className="or-loading">Connecting to oakridge…</div>
      </div>
    );
  }

  // Show unavailable state when OAKRIDGE_CORE_BASE_URL is unset
  if (!configQuery.data?.available) {
    return (
      <div className="or-shell" data-testid="or-shell">
        <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Back</button>
        <div className="or-unavailable" data-testid="or-unavailable">
          <h2>oakridge-core not configured</h2>
          <p>
            Set <code>OAKRIDGE_CORE_BASE_URL</code> on the kbbl server to enable
            workflow run inspection.
          </p>
        </div>
      </div>
    );
  }

  const navigateToRun = (id: string) => onNavigate(`oakridge/run/${encodeURIComponent(id)}`);
  const navigateToArtifact = (id: string) => onNavigate(`oakridge/artifact/${encodeURIComponent(id)}`);
  const navigateToRuns = () => onNavigate("oakridge");

  let content: React.ReactNode;
  switch (route.sub) {
    case "runs":
      content = <RunListView onSelectRun={navigateToRun} />;
      break;
    case "run":
      content = (
        <RunDetailView
          runId={route.id}
          onBack={navigateToRuns}
          onSelectArtifact={navigateToArtifact}
        />
      );
      break;
    case "artifact":
      content = <ArtifactDetailView artifactId={route.id} onBack={navigateToRuns} />;
      break;
  }

  return (
    <div className="or-shell" data-testid="or-shell">
      <nav className="or-shell__nav">
        <button
          type="button"
          className="or-shell__back"
          onClick={onBack}
          aria-label="Back to kbbl"
        >
          ← kbbl
        </button>
        <span className="or-shell__breadcrumb">oakridge</span>
        <button
          type="button"
          className={`or-shell__nav-item ${route.sub === "runs" ? "or-shell__nav-item--active" : ""}`}
          onClick={navigateToRuns}
        >
          Runs
        </button>
      </nav>
      <main className="or-shell__content">
        {content}
      </main>
    </div>
  );
}

const shellQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

interface OakridgeShellProps {
  route: OakridgeSubRoute;
  onBack: () => void;
}

export function OakridgeShell({ route, onBack }: OakridgeShellProps) {
  const onNavigate = (hash: string) => {
    window.location.hash = hash;
  };

  return (
    <QueryClientProvider client={shellQueryClient}>
      <OakridgeShellInner route={route} onBack={onBack} onNavigate={onNavigate} />
    </QueryClientProvider>
  );
}

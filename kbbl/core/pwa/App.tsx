import { useEffect } from "react";

import { useHashRoute } from "./hooks/useHashRoute";
import { useHashSid } from "./hooks/useHashSid";
import { useServerConfig } from "./hooks/useServerConfig";
import { useTheme } from "./hooks/useTheme";
import { useInbox } from "./hooks/useInbox";
import { useToastStore } from "./hooks/useToast";
import { resumeSession } from "./lib/session";
import { useStore } from "./state/store";
import type { Sid } from "./lib/ids";

import { OakridgeShell } from "./oakridge/OakridgeShell";

import { SessionListView } from "./views/SessionListView";
import { SessionView } from "./views/SessionView";
import { ToastViewport } from "./components/organisms/ToastViewport";
import { PendingApprovalsBadge } from "./components/organisms/PendingApprovalsBadge";
import { useOakridgeConfig } from "./oakridge/hooks/useOakridgeConfig";
import { useOakridgeInvalidationStream } from "./oakridge/hooks/useOakridgeInvalidationStream";
import { useOakridgeRunEventStream } from "./oakridge/hooks/useOakridgeRunEventStream";

type PrimarySurface = "runs" | "sessions" | "attention";

interface PrimaryNavProps {
  activeSurface: PrimarySurface;
  attentionCount: number;
}

function PrimaryNav({ activeSurface, attentionCount }: PrimaryNavProps) {
  const navigate = (hash: string) => { window.location.hash = hash; };
  return (
    <nav className="app-surface-nav" aria-label="Primary">
      <span className="app-surface-nav__brand">oakridge</span>
      <button type="button" className={activeSurface === "runs" ? "app-surface-nav__item app-surface-nav__item--active" : "app-surface-nav__item"} onClick={() => navigate("oakridge")}>Runs</button>
      <button type="button" className={activeSurface === "sessions" ? "app-surface-nav__item app-surface-nav__item--active" : "app-surface-nav__item"} onClick={() => navigate("sessions")}>Sessions</button>
      <button type="button" className={activeSurface === "attention" ? "app-surface-nav__item app-surface-nav__item--active" : "app-surface-nav__item"} onClick={() => navigate("oakridge/review-inbox")}>
        Attention
        {attentionCount > 0 && <span className="app-surface-nav__count">{attentionCount}</span>}
      </button>
    </nav>
  );
}

export function App() {
  const route = useHashRoute();
  const [sid, navigate] = useHashSid();
  const [theme, toggleTheme] = useTheme();
  const oakridgeConfig = useOakridgeConfig();
  const pushToast = useToastStore((state) => state.pushToast);

  // Both Oakridge subscriptions live above the route branch so changing
  // surfaces keeps the shared query cache current and the single EventSource
  // connected. The hooks multiplex through the same browser connection.
  const isOakridgeAvailable = oakridgeConfig.data?.available === true;
  useOakridgeInvalidationStream(isOakridgeAvailable);
  useOakridgeRunEventStream(isOakridgeAvailable, (event) => {
    pushToast({
      kind: event.operation === "materialization_failed" ? "error" : "info",
      message: event.operation.replaceAll("_", " "),
    });
  });

  // SSE subscription: writes inbox snapshots + status into the store.
  // When the active session is purged from another client, drop back to
  // the inbox list so SessionView isn't left rendering a stale transcript
  // with no underlying record.
  useInbox({
    onSessionRemoved: (removedSid) => {
      if (removedSid === sid) navigate(null);
    },
  });

  // Inbox slice selectors — each reads only its own field so unrelated store
  // mutations don't re-render App.
  const sessions = useStore((s) => s.sessions);
  const inboxStatus = useStore((s) => s.inboxStatus);
  const hydrateSession = useStore((s) => s.hydrateSession);
  const setCurrentSid = useStore((s) => s.setCurrentSid);

  // Mirror the URL-derived sid into the store so other components can read
  // currentSid via slice selectors without threading it through props.
  useEffect(() => {
    setCurrentSid(sid as Sid | null);
  }, [sid, setCurrentSid]);

  const config = useServerConfig();

  const activeSurface: PrimarySurface = sid !== null || route?.view === "sessions"
    ? "sessions"
    : route?.view === "oakridge" && route.route.sub === "review-inbox"
      ? "attention"
      : "runs";

  // Workflow routes take precedence over session hashes.
  let view: React.ReactNode;
  if (route?.view === "oakridge") {
    view = <OakridgeShell route={route.route} />;
  } else if (sid !== null) {
    view = (
      <SessionView
        sid={sid}
        snapshot={sessions.get(sid as Sid) ?? null}
        inboxStatus={inboxStatus}
        chrome={{
          kind: "route",
          theme,
          onToggleTheme: toggleTheme,
          onBack: () => navigate(null),
        }}
        onResume={(parentSid) => resumeSession(parentSid, hydrateSession, navigate)}
      />
    );
  } else if (route?.view === "sessions") {
    view = (
      <SessionListView
        sessions={sessions}
        inboxStatus={inboxStatus}
        theme={theme}
        defaultWorkdir={config?.defaultWorkdir ?? null}
        defaultRuntimeId={config?.defaultRuntimeId ?? "claude-code"}
        runtimes={config?.runtimes ?? []}
        onToggleTheme={toggleTheme}
        onSelect={(nextSid) => navigate(nextSid)}
        onHydrateSession={hydrateSession}
      />
    );
  } else {
    view = <OakridgeShell route={{ sub: "runs" }} />;
  }

  return (
    <>
      <PrimaryNav activeSurface={activeSurface} attentionCount={0} />
      {view}
      <PendingApprovalsBadge />
      <ToastViewport />
    </>
  );
}

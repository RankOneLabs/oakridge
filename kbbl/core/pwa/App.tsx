import { useEffect } from "react";

import { useHashRoute } from "./hooks/useHashRoute";
import { useHashSid } from "./hooks/useHashSid";
import { useServerConfig } from "./hooks/useServerConfig";
import { useTheme } from "./hooks/useTheme";
import { useInbox } from "./hooks/useInbox";
import { resumeSession } from "./lib/session";
import { useStore } from "./state/store";
import type { Sid } from "./lib/ids";

import { OakridgeShell } from "./oakridge/OakridgeShell";

import { SessionListView } from "./views/SessionListView";
import { SessionView } from "./views/SessionView";
import { ToastViewport } from "./components/organisms/ToastViewport";
import { PendingApprovalsBadge } from "./components/organisms/PendingApprovalsBadge";

export function App() {
  const route = useHashRoute();
  const [sid, navigate] = useHashSid();
  const [theme, toggleTheme] = useTheme();

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

  // Workflow routes take precedence over session hashes.
  let view: React.ReactNode;
  if (route?.view === "oakridge") {
    view = (
      <OakridgeShell
        route={route.route}
        onBack={() => { window.location.hash = ""; }}
      />
    );
  } else if (sid !== null) {
    view = (
      <SessionView
        sid={sid}
        snapshot={sessions.get(sid as Sid) ?? null}
        inboxStatus={inboxStatus}
        softThresholdTokens={config?.softThresholdTokens ?? null}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBack={() => navigate(null)}
        onResume={(parentSid) => resumeSession(parentSid, hydrateSession, navigate)}
      />
    );
  } else {
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
  }

  return (
    <>
      {view}
      <PendingApprovalsBadge />
      <ToastViewport />
    </>
  );
}

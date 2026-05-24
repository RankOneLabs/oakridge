import { useEffect, useState } from "react";

import { useHashRoute } from "./hooks/useHashRoute";
import { useHashSid } from "./hooks/useHashSid";
import { useServerConfig } from "./hooks/useServerConfig";
import { useTheme } from "./hooks/useTheme";
import { useInbox } from "./hooks/useInbox";
import { resumeSession } from "./lib/session";
import { useStore } from "./state/store";
import type { Sid } from "./lib/ids";

import { PlanReviewView } from "./review/plan/PlanReviewView";
import { BriefReviewView } from "./review/brief/BriefReviewView";
import { CohortReviewView } from "./review/cohort/CohortReviewView";

import { SessionListView } from "./views/SessionListView";
import { SessionView } from "./views/SessionView";
import { ToastViewport } from "./components/organisms/ToastViewport";

export function App() {
  const route = useHashRoute();
  const [sid, navigate] = useHashSid();
  const [theme, toggleTheme] = useTheme();

  // SSE subscription: writes inbox snapshot + status + compact-suggestions
  // into the store. When the active session is purged from another client,
  // drop back to the inbox list so SessionView isn't left rendering a stale
  // transcript with no underlying record.
  useInbox({
    onSessionRemoved: (removedSid) => {
      if (removedSid === sid) navigate(null);
    },
  });

  // Inbox slice selectors — each reads only its own field so unrelated store
  // mutations don't re-render App.
  const sessions = useStore((s) => s.sessions);
  const inMemorySids = useStore((s) => s.inMemorySids);
  const inboxStatus = useStore((s) => s.inboxStatus);
  const compactSuggestions = useStore((s) => s.compactSuggestions);
  const hydrateSession = useStore((s) => s.hydrateSession);
  const clearCompactSuggestion = useStore((s) => s.clearCompactSuggestion);
  const setCurrentSid = useStore((s) => s.setCurrentSid);

  // Mirror the URL-derived sid into the store so other components can read
  // currentSid via slice selectors without threading it through props.
  useEffect(() => {
    setCurrentSid(sid as Sid | null);
  }, [sid, setCurrentSid]);

  const config = useServerConfig();
  const [softThresholdTokens, setSoftThresholdTokens] = useState<number>(50000);
  const [thresholdInput, setThresholdInput] = useState<string>("50000");

  useEffect(() => {
    if (typeof config?.softThresholdTokens === "number") {
      setSoftThresholdTokens(config.softThresholdTokens);
      setThresholdInput(String(config.softThresholdTokens));
    }
  }, [config?.softThresholdTokens]);

  // Hash routing precedence: plan/brief/cohort views win over session/task
  // views. These use path-style hashes (#plan/<id>, #brief/<id>) which don't
  // collide with the query-param style #sid=X and #task=X routes.
  let view: React.ReactNode;
  if (route?.view === "plan") {
    view = (
      <PlanReviewView
        id={route.id}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBack={() => { window.location.hash = ""; }}
      />
    );
  } else if (route?.view === "brief") {
    view = (
      <BriefReviewView
        id={route.id}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBack={() => { window.location.hash = ""; }}
      />
    );
  } else if (route?.view === "cohort") {
    view = (
      <CohortReviewView
        id={route.id}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBack={() => { window.location.hash = ""; }}
      />
    );
  } else if (sid !== null) {
    view = (
      <SessionView
        sid={sid}
        snapshot={sessions.get(sid as Sid) ?? null}
        inMemory={inMemorySids.has(sid as Sid)}
        inboxStatus={inboxStatus}
        theme={theme}
        compactSuggestion={compactSuggestions.get(sid as Sid) ?? null}
        onClearCompactSuggestion={() => clearCompactSuggestion(sid as Sid)}
        softThresholdTokens={softThresholdTokens}
        thresholdInput={thresholdInput}
        onSoftThresholdChange={(n, input) => {
          setSoftThresholdTokens(n);
          setThresholdInput(input);
        }}
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
        defaultWorkdir={config?.defaultWorkdir ?? ""}
        onToggleTheme={toggleTheme}
        onSelect={(nextSid) => navigate(nextSid)}
        onHydrateSession={hydrateSession}
      />
    );
  }

  return (
    <>
      {view}
      <ToastViewport />
    </>
  );
}

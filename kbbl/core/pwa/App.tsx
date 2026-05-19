import { useState, useEffect } from "react";

import { useHashRoute } from "./hooks/useHashRoute";
import { useHashSid } from "./hooks/useHashSid";
import { useHashTaskId } from "./hooks/useHashTaskId";
import { useServerConfig } from "./hooks/useServerConfig";
import { useTheme } from "./hooks/useTheme";
import { useInbox } from "./hooks/useInbox";
import { resumeSession } from "./lib/session";

import { PlanReviewView } from "./review/plan/PlanReviewView";
import { BriefReviewView } from "./review/brief/BriefReviewView";
import { CohortReviewView } from "./review/cohort/CohortReviewView";

import { SessionListView } from "./views/SessionListView";
import { SessionView } from "./views/SessionView";
import { TaskView } from "./views/TaskView";

export function App() {
  const route = useHashRoute();
  const [sid, navigate] = useHashSid();
  const [taskId, navigateTask] = useHashTaskId();
  const [theme, toggleTheme] = useTheme();
  const { sessions, inMemorySids, inboxStatus, compactSuggestions, clearCompactSuggestion, hydrateSession } = useInbox({
    // When the active session is purged from another client / tab, drop
    // back to the inbox list so SessionView isn't left rendering a stale
    // transcript with no underlying session record. Comparing inside the
    // callback (not via deps) is fine because the ref dance in useInbox
    // ensures we always see the latest sid closure.
    onSessionRemoved: (removedSid) => {
      if (removedSid === sid) navigate(null);
    },
  });
  const config = useServerConfig();
  const [softThresholdTokens, setSoftThresholdTokens] = useState<number>(50000);
  const [thresholdInput, setThresholdInput] = useState<string>("50000");

  useEffect(() => {
    if (typeof config?.softThresholdTokens === "number") {
      setSoftThresholdTokens(config.softThresholdTokens);
      setThresholdInput(String(config.softThresholdTokens));
    }
  }, [config?.softThresholdTokens]);

  // Hash routing precedence: plan/brief views win over session/task views.
  // These use path-style hashes (#plan/<id>, #brief/<id>) which don't
  // collide with the query-param style #sid=X and #task=X routes.
  if (route?.view === "plan") {
    return (
      <PlanReviewView
        id={route.id}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBack={() => { window.location.hash = ""; }}
      />
    );
  }
  if (route?.view === "brief") {
    return (
      <BriefReviewView
        id={route.id}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBack={() => { window.location.hash = ""; }}
      />
    );
  }
  if (route?.view === "cohort") {
    return (
      <CohortReviewView
        id={route.id}
        theme={theme}
        onToggleTheme={toggleTheme}
        onBack={() => { window.location.hash = ""; }}
      />
    );
  }

  // Precedence: #sid wins over #task. The hash writers always overwrite
  // the entire fragment, so both being set simultaneously is unreachable
  // by normal navigation; this branch is a defensive ordering only.
  if (sid !== null) {
    return (
      <SessionView
        sid={sid}
        snapshot={sessions.get(sid) ?? null}
        inMemory={inMemorySids.has(sid)}
        inboxStatus={inboxStatus}
        theme={theme}
        compactSuggestion={compactSuggestions.get(sid) ?? null}
        onClearCompactSuggestion={() => clearCompactSuggestion(sid)}
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
  }
  if (taskId !== null) {
    return (
      <TaskView
        taskId={taskId}
        theme={theme}
        safirWebUrl={config?.safirWebUrl ?? "http://localhost:3000"}
        onToggleTheme={toggleTheme}
        onBack={() => navigateTask(null)}
      />
    );
  }
  return (
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

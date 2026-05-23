import { useEffect, useState } from "react";

import { useHashRoute } from "./hooks/useHashRoute";
import { useHashSid } from "./hooks/useHashSid";
import { useHashTaskId } from "./hooks/useHashTaskId";
import { useServerConfig } from "./hooks/useServerConfig";
import { useTheme } from "./hooks/useTheme";
import { useInbox } from "./hooks/useInbox";
import { resumeSession } from "./lib/session";
import { useStore } from "./state/store";
import type { Sid, TaskId } from "./lib/ids";

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
  const setCurrentTaskId = useStore((s) => s.setCurrentTaskId);

  // Mirror the URL-derived route ids into the store so other components
  // (future cohorts) can read currentSid/currentTaskId via slice selectors
  // without threading them through props.
  useEffect(() => {
    setCurrentSid(sid as Sid | null);
  }, [sid, setCurrentSid]);
  useEffect(() => {
    setCurrentTaskId(taskId as TaskId | null);
  }, [taskId, setCurrentTaskId]);

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

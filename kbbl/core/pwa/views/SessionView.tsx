import { useEffect, useMemo, useRef, useState } from "react";

import type { SessionSnapshot, Status } from "../types";
import { useAcpSession } from "../hooks/useAcpSession";
import { usePendingSends } from "../hooks/usePendingSends";
import { readStoredThreadExpanded, writeStoredThreadExpanded } from "../lib/storage";
import { useAutoScrollAndLayout } from "../hooks/useAutoScrollAndLayout";
import { selectOpenPermissions } from "../lib/session-items";
import { selectPanelExecution } from "../lib/session-panel";
import { useSessionTranscript } from "../state/session-transcript-store";

import { Button } from "../components/atoms/Button";
import { SessionTopBar } from "../components/molecules/SessionTopBar";
import { SessionThread } from "../components/organisms/SessionThread";
import { SessionConfigBar } from "../components/organisms/SessionConfigBar";
import { InputBox } from "../components/organisms/InputBox";
import { PendingUserBubbleEntry } from "../components/organisms/PendingUserBubbleEntry";
import { AgentMessage } from "../components/molecules/AgentMessage";
import { EndedBanner } from "../components/organisms/EndedBanner";
import { AgentStatusPanel } from "../components/organisms/AgentStatusPanel";
import { SkillRail } from "../components/organisms/SkillRail";
import { permissionCardAnchorId } from "../components/organisms/PermissionCard";
import { readHashPermissionTarget, readHashSessionTarget } from "../lib/hash";
import {
  DOCUMENT_SESSION_SURFACE_LAYOUT,
  type SessionSurfaceChrome,
  type SessionSurfaceLayout,
} from "../lib/session-surface";

export function SessionView({
  sid,
  snapshot,
  inboxStatus,
  chrome,
  onResume,
  layout = DOCUMENT_SESSION_SURFACE_LAYOUT,
}: {
  sid: string;
  snapshot: SessionSnapshot | null;
  inboxStatus: Status;
  /** Which app-level affordances the host contributes to the top bar. */
  chrome: SessionSurfaceChrome;
  onResume: (parentSid: string) => Promise<string | null>;
  /** Where the session input bar anchors. */
  layout?: SessionSurfaceLayout;
}) {
  const appRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<HTMLElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const [isThreadExpanded, setThreadExpanded] = useState(() => readStoredThreadExpanded(sid));
  const [threadSid, setThreadSid] = useState(sid);
  if (threadSid !== sid) {
    setThreadSid(sid);
    setThreadExpanded(readStoredThreadExpanded(sid));
  }

  function toggleThread() {
    const nextExpanded = !isThreadExpanded;
    setThreadExpanded(nextExpanded);
    writeStoredThreadExpanded(sid, nextExpanded);
  }

  const {
    hasEarlier,
    isTruncated,
    isLoadingEarlier,
    loadEarlier,
    sessionState,
    streamStatus,
    expired,
    summary,
    unavailableReason,
    streamError,
    openTurns,
    terminalTurnKeys,
  } = useAcpSession(sid);

  const openPermissions = useMemo(() => selectOpenPermissions(sessionState), [sessionState]);
  const turnActive = sessionState.active_turn !== null;
  const sessionTitle = sessionState.session_title;
  const focusedPermissionRef = useRef<string | null>(null);
  const [hashFocusVersion, setHashFocusVersion] = useState(0);

  useEffect(() => {
    const onHashChange = () => setHashFocusVersion((version) => version + 1);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    focusedPermissionRef.current = null;
  }, [sid]);

  useEffect(() => {
    const requestedId = readHashPermissionTarget();
    const request_id = requestedId ?? (readHashSessionTarget() === "pending-permission" ? openPermissions[0]?.requestId : null);
    if (!request_id || focusedPermissionRef.current === `${request_id}:${hashFocusVersion}`) return;
    const card = document.getElementById(permissionCardAnchorId(request_id));
    if (!card) return;
    focusedPermissionRef.current = `${request_id}:${hashFocusVersion}`;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.focus({ preventScroll: true });
  }, [sid, openPermissions, hashFocusVersion]);

  const sessionStatus = snapshot?.status ?? null;
  const sessionClosed =
    sessionStatus === "ended" ||
    sessionStatus === "fenced" ||
    sessionStatus === "failed";

  const {
    pendingSends,
    addPendingSend,
    acceptPendingSend,
    removePendingSend,
    lastPendingClientMessageId,
  } = usePendingSends(sid, { openTurns, activeTurn: sessionState.active_turn, terminalTurnKeys, sessionStatus });

  const [isInterrupting, setIsInterrupting] = useState(false);
  const transcript = useSessionTranscript(sid, (state) => state);
  const operatorState = selectPanelExecution({
    transcript, snapshot, pending_sends: pendingSends, is_interrupting: isInterrupting,
  });

  const awaitingResult =
    !sessionClosed && operatorState.kind !== "idle";

  // Wall-clock start of the visible wait, for the thinking indicator's
  // elapsed counter: reset whenever the wait begins.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  useEffect(() => {
    setTurnStartedAt((prev) => (awaitingResult ? (prev ?? Date.now()) : null));
  }, [awaitingResult]);

  useAutoScrollAndLayout({ appRef, topBarRef, bottomBarRef });

  const sendCallbacks = {
    onSend: addPendingSend,
    onSendAccepted: acceptPendingSend,
    onSendFailed: removePendingSend,
  };

  const canInput = snapshot !== null && !sessionClosed;

  // Anchoring is a scoped class rather than an inline style object: the bar's
  // viewport-fixed rules and the sticky override both belong to the stylesheet
  // that owns .bottom-stack, and one system is what keeps the safe-area
  // padding and the desktop max-width in a single place.
  const surfaceClassName = layout.barAnchor === "surface" ? "app session-surface--embedded" : "app";

  return (
    <div className={surfaceClassName} ref={appRef}>
      <SessionTopBar
        ref={topBarRef}
        sid={sid}
        snapshot={snapshot && sessionTitle ? { ...snapshot, name: sessionTitle } : snapshot}
        streamStatus={streamStatus}
        inboxStatus={inboxStatus}
        usage={sessionState.usage}
        chrome={chrome}
      />
      <AgentStatusPanel
        sid={sid}
        snapshot={snapshot}
        pendingSends={pendingSends}
        isInterrupting={isInterrupting}
        localWaitStartedMs={turnStartedAt}
        sessionClosed={sessionClosed}
      />
      <Button className="my-2 self-start" size="small" aria-expanded={isThreadExpanded} onClick={toggleThread}>
        {isThreadExpanded ? "Hide conversation" : "Show conversation"}
      </Button>
      {canInput && (
        <SessionConfigBar sid={sid} options={sessionState.config_options} disabled={awaitingResult} />
      )}
      {streamError !== null && (
        <div className="row row-system">
          <div className="notice notice-muted">stream: {streamError}</div>
        </div>
      )}
      {isThreadExpanded && (
        <SessionThread
          key={sid}
          session={{ sid, sessionClosed }}
          sendCallbacks={sendCallbacks}
          paging={{ hasEarlier, isTruncated, isLoadingEarlier, loadEarlier }}
          notices={<>
            {summary !== null && (
              <>
                <div className="row row-system">
                  <div className="notice notice-muted">
                    Recovered session summary · {summary.method.replaceAll("_", " ")} · {new Date(summary.produced_at).toLocaleString()}
                  </div>
                </div>
                <AgentMessage text={summary.markdown} />
              </>
            )}
            {expired && summary === null && (
              <div className="row row-system">
                <div className="notice notice-muted">
                  session history unavailable
                  {unavailableReason === "missing_acp_session_id"
                    ? " — no agent session id was recorded"
                    : " — the agent no longer holds this session's transcript and no terminal summary was captured"}
                </div>
              </div>
            )}
          </>}
        >
          {pendingSends.map((m) => (
            <PendingUserBubbleEntry
              key={m.turnKey ?? `sending:${m.clientMessageId}`}
              text={m.text}
              sentAt={m.sentAt}
              status={m.status}
              isLatest={m.clientMessageId === lastPendingClientMessageId}
            />
          ))}
        </SessionThread>
      )}
      <div className="bottom-stack" ref={bottomBarRef}>
        {canInput && (
          <InputBox
            sid={sid}
            tools={<SkillRail sid={sid} snapshot={snapshot} commands={sessionState.commands} position="composer" />}
            {...sendCallbacks}
            isTurnActive={turnActive}
            onInterruptingChange={setIsInterrupting}
          />
        )}
        {!canInput && sessionClosed && (
          <EndedBanner sid={sid} onResume={onResume} />
        )}
      </div>
    </div>
  );
}

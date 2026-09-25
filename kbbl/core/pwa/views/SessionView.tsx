import { useEffect, useMemo, useRef, useState } from "react";

import type { SessionSnapshot, Status } from "../types";
import { useAcpSession } from "../hooks/useAcpSession";
import { usePendingSends } from "../hooks/usePendingSends";
import { useElapsedSeconds } from "../hooks/useElapsedSeconds";
import { useAutoScrollAndLayout } from "../hooks/useAutoScrollAndLayout";
import { projectTimeline } from "../lib/acp-timeline";
import { useInvokeAgentCommand } from "../hooks/useSkills";
import {
  operatorStateLabel,
  selectOperatorExecutionState,
} from "../lib/operator-state";

import { SessionTopBar } from "../components/organisms/SessionTopBar";
import { SessionTimeline } from "../components/organisms/SessionTimeline";
import { SessionConfigBar } from "../components/organisms/SessionConfigBar";
import { InputBox } from "../components/organisms/InputBox";
import { PendingUserBubble } from "../components/molecules/PendingUserBubble";
import { AgentMessage } from "../components/molecules/AgentMessage";
import { EndedBanner } from "../components/organisms/EndedBanner";
import { ThinkingIndicator } from "../components/atoms/ThinkingIndicator";
import { SkillRail } from "../components/organisms/SkillRail";
import { CompactControl } from "../components/molecules/CompactControl";
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
  /**
   * Which host this view scrolls and where its input bar anchors. Defaults to
   * the document/viewport layout, so the standalone route renders exactly as
   * it did before anchoring became injectable.
   */
  layout?: SessionSurfaceLayout;
}) {
  const appRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<HTMLElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);

  const isLegacyArchive = snapshot?.source === "legacy_archive";
  // A pre-ACP archived session has no ACP stream — don't open one.
  const {
    events,
    streamStatus,
    expired,
    summary,
    unavailableReason,
    streamError,
    openTurns,
    historyLoaded,
  } = useAcpSession(sid, !isLegacyArchive);

  const projection = useMemo(() => projectTimeline(events), [events]);
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
    const request_id = requestedId ?? (readHashSessionTarget() === "pending-permission" ? projection.openPermissions[0]?.requestId : null);
    if (!request_id || focusedPermissionRef.current === `${request_id}:${hashFocusVersion}`) return;
    const card = document.getElementById(permissionCardAnchorId(request_id));
    if (!card) return;
    focusedPermissionRef.current = `${request_id}:${hashFocusVersion}`;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.focus({ preventScroll: true });
  }, [projection.openPermissions, hashFocusVersion]);
  const compactMutation = useInvokeAgentCommand(sid);

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
  } = usePendingSends(sid, events, openTurns, sessionStatus);

  const [isInterrupting, setIsInterrupting] = useState(false);
  const operatorState = selectOperatorExecutionState({
    sessionStatus,
    streamStatus,
    historyLoaded: isLegacyArchive || historyLoaded,
    pendingSends,
    isTurnActive: projection.turnActive,
    hasOpenPermission: projection.openPermissions.length > 0,
    isInterrupting,
  });

  const awaitingResult =
    !sessionClosed && operatorState.kind !== "idle";

  // Wall-clock start of the visible wait, for the thinking indicator's
  // elapsed counter: reset whenever the wait begins.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  useEffect(() => {
    setTurnStartedAt((prev) => (awaitingResult ? (prev ?? Date.now()) : null));
  }, [awaitingResult]);
  const elapsedSec = useElapsedSeconds(turnStartedAt, awaitingResult);

  useAutoScrollAndLayout({
    sid,
    eventsLength: events.length,
    pendingLength: pendingSends.length,
    awaitingResult,
    sessionStatus,
    appRef,
    topBarRef,
    bottomBarRef,
    layout,
  });

  const canInput = snapshot !== null && !isLegacyArchive && !sessionClosed;

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
        snapshot={snapshot}
        streamStatus={streamStatus}
        inboxStatus={inboxStatus}
        usage={projection.usage}
        chrome={chrome}
      />
      {isLegacyArchive ? (
        <div className="session-ended-banner">
          <div className="session-ended-text">
            Pre-ACP archived session · transcript no longer viewable since the
            ACP cutover
          </div>
        </div>
      ) : (
        <>
          {canInput && (
            <SessionConfigBar
              sid={sid}
              options={projection.configOptions}
              disabled={awaitingResult}
            />
          )}
          {streamError !== null && (
            <div className="row row-system">
              <div className="notice notice-muted">stream: {streamError}</div>
            </div>
          )}
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
          <SessionTimeline
            sid={sid}
            items={projection.items}
            sessionClosed={sessionClosed}
          />
          {pendingSends.map((m) => (
            <PendingUserBubble
              key={m.clientMessageId}
              text={m.text}
              sentAt={m.sentAt}
              status={m.status}
              isLatest={m.clientMessageId === lastPendingClientMessageId}
            />
          ))}
          {operatorState.kind !== "idle" && !sessionClosed && (
            <ThinkingIndicator
              label={operatorStateLabel(operatorState)}
              elapsedSec={elapsedSec}
              outputTokens={null}
            />
          )}
        </>
      )}
      <div className="bottom-stack" ref={bottomBarRef}>
        {canInput && (
          <CompactControl
            isPending={compactMutation.isPending}
            error={
              compactMutation.error instanceof Error
                ? compactMutation.error.message
                : null
            }
            onCompact={() => compactMutation.mutate("compact")}
          />
        )}
        {canInput && (
          <SkillRail sid={sid} snapshot={snapshot} commands={projection.commands} />
        )}
        {canInput && (
          <InputBox
            sid={sid}
            onSend={addPendingSend}
            onSendAccepted={acceptPendingSend}
            onSendFailed={removePendingSend}
            canStop={true}
            isTurnActive={projection.turnActive}
            onInterruptingChange={setIsInterrupting}
          />
        )}
        {!canInput && !isLegacyArchive && sessionClosed && (
          <EndedBanner sid={sid} onResume={onResume} />
        )}
      </div>
    </div>
  );
}

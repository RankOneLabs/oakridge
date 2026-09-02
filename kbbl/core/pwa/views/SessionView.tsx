import { useEffect, useMemo, useRef, useState } from "react";

import type { SessionSnapshot, Status, Theme } from "../types";
import { useAcpSession } from "../hooks/useAcpSession";
import { usePendingSends } from "../hooks/usePendingSends";
import { useElapsedSeconds } from "../hooks/useElapsedSeconds";
import { useAutoScrollAndLayout } from "../hooks/useAutoScrollAndLayout";
import { projectTimeline } from "../lib/acp-timeline";
import {
  operatorStateLabel,
  selectOperatorExecutionState,
} from "../lib/operator-state";

import { SessionTopBar } from "../components/organisms/SessionTopBar";
import { SessionTimeline } from "../components/organisms/SessionTimeline";
import { SessionConfigBar } from "../components/organisms/SessionConfigBar";
import { InputBox } from "../components/organisms/InputBox";
import { PendingUserBubble } from "../components/molecules/PendingUserBubble";
import { EndedBanner } from "../components/organisms/EndedBanner";
import { ThinkingIndicator } from "../components/atoms/ThinkingIndicator";
import { SkillRail } from "../components/organisms/SkillRail";

export function SessionView({
  sid,
  snapshot,
  inboxStatus,
  theme,
  onToggleTheme,
  onBack,
  onResume,
}: {
  sid: string;
  snapshot: SessionSnapshot | null;
  inboxStatus: Status;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
  onResume: (parentSid: string) => Promise<string | null>;
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
    streamError,
    openTurns,
    historyLoaded,
  } = useAcpSession(sid, !isLegacyArchive);

  const projection = useMemo(() => projectTimeline(events), [events]);

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
  });

  const canInput = snapshot !== null && !isLegacyArchive && !sessionClosed;

  return (
    <div className="app" ref={appRef}>
      <SessionTopBar
        ref={topBarRef}
        sid={sid}
        snapshot={snapshot}
        streamStatus={streamStatus}
        inboxStatus={inboxStatus}
        usage={projection.usage}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onBack={onBack}
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
          {expired && (
            <div className="row row-system">
              <div className="notice notice-muted">
                history expired — the agent no longer holds this session's
                transcript
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

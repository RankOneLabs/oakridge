import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  SessionSnapshot, Theme, Status, CompactSuggestion, CCUserPayload,
} from "../types";
import { useInFlightAssistant, turnStartedAtMs } from "../hooks/useInFlightAssistant";
import { useElapsedSeconds } from "../hooks/useElapsedSeconds";
import { useSessionStream } from "../hooks/useSessionStream";
import { usePendingMessages } from "../hooks/usePendingMessages";
import { useAutoScrollAndLayout } from "../hooks/useAutoScrollAndLayout";
import { lastMessageEventId } from "../lib/events";

import { SessionTopBar } from "../components/organisms/SessionTopBar";
import { MetricsStrip } from "../components/organisms/MetricsStrip";
import { EventList } from "../components/organisms/EventList";
import { InputBox } from "../components/organisms/InputBox";
import { PendingUserBubble } from "../components/molecules/PendingUserBubble";
import { EndedBanner } from "../components/organisms/EndedBanner";
import { CompactedBanner } from "../components/organisms/CompactedBanner";
import { CompactSuggestionBanner } from "../components/organisms/CompactSuggestionBanner";
import { CompactingBanner } from "../components/molecules/CompactingBanner";
import { InFlightAssistantRow } from "../components/molecules/InFlightAssistantRow";
import { ThinkingIndicator } from "../components/atoms/ThinkingIndicator";
import {
  SessionTerminal,
  type SessionTerminalHandle,
} from "../components/organisms/SessionTerminal";

type ViewMode = "conversation" | "terminal";

export function SessionView({
  sid,
  snapshot,
  inMemory,
  inboxStatus,
  theme,
  compactSuggestion,
  onClearCompactSuggestion,
  softThresholdTokens,
  thresholdInput,
  onSoftThresholdChange,
  onToggleTheme,
  onBack,
  onResume,
}: {
  sid: string;
  snapshot: SessionSnapshot | null;
  inMemory: boolean;
  inboxStatus: Status;
  theme: Theme;
  compactSuggestion: CompactSuggestion | null;
  onClearCompactSuggestion: () => void;
  softThresholdTokens: number;
  thresholdInput: string;
  onSoftThresholdChange: (n: number, input: string) => void;
  onToggleTheme: () => void;
  onBack: () => void;
  onResume: (parentSid: string) => Promise<string | null>;
}) {
  const [showSystemEvents, setShowSystemEvents] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("conversation");
  const appRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<HTMLElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<SessionTerminalHandle>(null);

  // Raw PTY bytes go straight to the xterm instance, never through React
  // state. Stable identity keeps useSessionStream's SSE effect from churning.
  const handlePtyOutput = useCallback((content: string) => {
    terminalRef.current?.write(content);
  }, []);

  const { events, streamStatus, resolutions, yoloMode, allowedTools } =
    useSessionStream(sid, inMemory, handlePtyOutput);

  // The terminal container has no layout while the conversation view is shown,
  // so refit when it becomes visible.
  useEffect(() => {
    if (viewMode === "terminal") terminalRef.current?.fit();
  }, [viewMode]);

  const sessionStatus = snapshot?.status ?? null;

  const {
    pendingMessages,
    addPendingMessage,
    removePendingMessage,
    lastPendingLocalId,
  } = usePendingMessages(sid, events, sessionStatus);

  // Awaiting a turn result if the session is live AND (we have an optimistic
  // message in flight OR the transcript shows a user-input event more recent
  // than the most recent `result` event). The session-status gate prevents
  // the indicator from getting stuck on a read-only ended transcript when
  // the operator stops mid-turn or the subprocess crashes before emitting a
  // result. The events-derived clause means a viewer landing on a session
  // another phone just sent into still sees the thinking indicator.
  const awaitingResult = useMemo(() => {
    if (sessionStatus !== "live") return false;
    if (pendingMessages.length > 0) return true;
    let lastResultIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === "result") {
        lastResultIdx = i;
        break;
      }
    }
    for (let i = lastResultIdx + 1; i < events.length; i++) {
      const e = events[i];
      if (e.type === "user") {
        const p = e.payload as CCUserPayload;
        if (typeof p.message?.content === "string") return true;
      }
      if (e.type === "assistant") return true;
      if (e.type === "stream_event") return true;
      if (e.type === "assistant_delta") return true;
    }
    return false;
  }, [events, pendingMessages.length, sessionStatus]);

  useAutoScrollAndLayout({
    sid,
    eventsLength: events.length,
    pendingLength: pendingMessages.length,
    awaitingResult,
    sessionStatus,
    appRef,
    topBarRef,
    bottomBarRef,
  });

  const canInput = snapshot?.status === "live";
  // Only the bottom-most message bubble carries a timestamp. When a pending
  // bubble is in flight, that's the bottom; otherwise it's the latest text
  // event in the transcript.
  const latestEventId = useMemo(
    () => (pendingMessages.length > 0 ? null : lastMessageEventId(events)),
    [events, pendingMessages.length],
  );
  const inFlightAssistant = useInFlightAssistant(events, sid);
  const turnStart = useMemo(
    () => turnStartedAtMs(events, awaitingResult),
    [events, awaitingResult],
  );
  const elapsedSec = useElapsedSeconds(
    inFlightAssistant?.startedAt ?? turnStart,
    awaitingResult,
  );
  return (
    <div className="app" ref={appRef}>
      <SessionTopBar
        ref={topBarRef}
        sid={sid}
        snapshot={snapshot}
        streamStatus={streamStatus}
        inboxStatus={inboxStatus}
        eventCount={events.length}
        yoloMode={yoloMode}
        theme={theme}
        showSystemEvents={showSystemEvents}
        softThresholdTokens={softThresholdTokens}
        thresholdInput={thresholdInput}
        onThresholdChange={onSoftThresholdChange}
        onToggleSystemEvents={() => setShowSystemEvents((p) => !p)}
        onToggleTheme={onToggleTheme}
        onBack={onBack}
      />
      {compactSuggestion !== null && (
        <CompactSuggestionBanner
          sid={sid}
          tokens={compactSuggestion.tokens}
          onClear={onClearCompactSuggestion}
        />
      )}
      <div className="view-mode-toggle">
        <button
          type="button"
          aria-pressed={viewMode === "conversation"}
          className={`theme-toggle ${viewMode === "conversation" ? "is-on" : ""}`}
          onClick={() => setViewMode("conversation")}
        >
          Conversation
        </button>
        <button
          type="button"
          aria-pressed={viewMode === "terminal"}
          className={`theme-toggle ${viewMode === "terminal" ? "is-on" : ""}`}
          onClick={() => setViewMode("terminal")}
        >
          Terminal
        </button>
      </div>
      {viewMode === "conversation" ? (
        <>
          <MetricsStrip events={events} />
          <EventList
            events={events}
            resolutions={resolutions}
            allowedTools={allowedTools}
            sid={sid}
            sessionStatus={sessionStatus}
            showSystemEvents={showSystemEvents}
            latestEventId={latestEventId}
          />
          {pendingMessages.map((m) => (
            <PendingUserBubble
              key={m.localId}
              text={m.text}
              sentAt={m.sentAt}
              isLatest={m.localId === lastPendingLocalId}
            />
          ))}
          {awaitingResult && inFlightAssistant && (
            <InFlightAssistantRow message={inFlightAssistant} />
          )}
          {awaitingResult && (
            <ThinkingIndicator
              elapsedSec={elapsedSec}
              outputTokens={inFlightAssistant?.outputTokens ?? null}
            />
          )}
        </>
      ) : (
        <div className="session-terminal-wrap">
          {/* key={sid} forces a fresh xterm instance per session so a previous
              session's buffer never bleeds into a new one's output. */}
          <SessionTerminal key={sid} ref={terminalRef} />
        </div>
      )}
      {canInput && (
        <InputBox
          ref={bottomBarRef}
          sid={sid}
          onSend={addPendingMessage}
          onSendFailed={removePendingMessage}
          canStop={true}
          isTurnActive={awaitingResult}
        />
      )}
      {!canInput && snapshot?.status === "compacting" && (
        <CompactingBanner ref={bottomBarRef} />
      )}
      {!canInput &&
        snapshot?.status === "ended" &&
        snapshot.endReason === "compacted" && (
          <CompactedBanner
            key={sid}
            ref={bottomBarRef}
            sid={sid}
            successorSid={snapshot.successorSid}
            onOpenSuccessor={(nextSid) => {
              window.location.hash = `sid=${encodeURIComponent(nextSid)}`;
            }}
          />
        )}
      {!canInput &&
        snapshot?.status === "ended" &&
        snapshot.endReason !== "compacted" && (
          <EndedBanner ref={bottomBarRef} sid={sid} onResume={onResume} />
        )}
    </div>
  );
}

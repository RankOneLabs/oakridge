import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  EnvelopeEvent, SessionSnapshot, Theme, ResolutionMap,
  Status, CompactSuggestion, PendingMessage, CCUserPayload,
} from "../types";
import { useInFlightAssistant, turnStartedAtMs } from "../hooks/useInFlightAssistant";
import { useElapsedSeconds } from "../hooks/useElapsedSeconds";
import { lastMessageEventId, parseSlashCommand } from "../lib/events";

import { SessionTopBar } from "../components/organisms/SessionTopBar";
import { MetricsStrip } from "../components/organisms/MetricsStrip";
import { EventList } from "../components/organisms/EventList";
import { InputBox } from "../components/organisms/InputBox";
import { PendingUserBubble } from "../components/molecules/PendingUserBubble";
import { EndedBanner } from "../components/molecules/EndedBanner";
import { CompactedBanner } from "../components/molecules/CompactedBanner";
import { CompactSuggestionBanner } from "../components/molecules/CompactSuggestionBanner";
import { CompactingBanner } from "../components/molecules/CompactingBanner";
import { InFlightAssistantRow } from "../components/molecules/InFlightAssistantRow";
import { ThinkingIndicator } from "../components/atoms/ThinkingIndicator";

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
  const [events, setEvents] = useState<EnvelopeEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<Status>("connecting");
  const [resolutions, setResolutions] = useState<ResolutionMap>(
    () => new Map(),
  );
  const [yoloMode, setYoloMode] = useState(false);
  const [allowedTools, setAllowedTools] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [showSystemEvents, setShowSystemEvents] = useState(false);
  const seenIds = useRef<Set<number>>(new Set());
  const pendingIdSeq = useRef(0);
  const appRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<HTMLElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);

  // Awaiting a turn result if the session is live AND (we have an optimistic
  // message in flight OR the transcript shows a user-input event more recent
  // than the most recent `result` event). The session-status gate prevents
  // the indicator from getting stuck on a read-only ended transcript when
  // the operator stops mid-turn or the subprocess crashes before emitting a
  // result. The events-derived clause means a viewer landing on a session
  // another phone just sent into still sees the thinking indicator.
  const sessionStatus = snapshot?.status ?? null;
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
    }
    return false;
  }, [events, pendingMessages.length, sessionStatus]);

  // Auto-scroll only when the user is already pinned near the bottom. If the
  // operator has scrolled up to read earlier output, new messages must not
  // yank them back down. A locally-sent message (pendingMessages increases)
  // is treated as an intent to follow along, so re-stick to bottom in that
  // case.
  const stickToBottomRef = useRef(true);
  const prevPendingLenRef = useRef(0);
  useEffect(() => {
    const STICK_THRESHOLD = 80;
    const onScroll = () => {
      const doc = document.documentElement;
      const distFromBottom =
        doc.scrollHeight - window.scrollY - window.innerHeight;
      stickToBottomRef.current = distFromBottom < STICK_THRESHOLD;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (pendingMessages.length > prevPendingLenRef.current) {
      stickToBottomRef.current = true;
    }
    prevPendingLenRef.current = pendingMessages.length;
    if (stickToBottomRef.current) {
      window.scrollTo({ top: document.documentElement.scrollHeight });
    }
  }, [events.length, pendingMessages.length, awaitingResult]);

  // Push the rendered top-bar / bottom-bar heights onto .app as CSS vars so
  // .events can pad first/last messages clear of the sticky bars. Both bars
  // resize at runtime — top bar grows when YOLO error chips appear, input
  // bar grows as the textarea expands and when the error row toggles — so
  // we re-measure via ResizeObserver. The bottom ref lands on whichever of
  // InputBox / EndedBanner is mounted; re-running on sessionStatus changes
  // re-binds the observer to the new node when the bar swaps.
  useLayoutEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const top = topBarRef.current;
    const bottom = bottomBarRef.current;
    const update = () => {
      if (top) app.style.setProperty("--top-bar-h", `${top.offsetHeight}px`);
      if (bottom)
        app.style.setProperty("--bottom-bar-h", `${bottom.offsetHeight}px`);
      else app.style.removeProperty("--bottom-bar-h");
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    if (top) ro.observe(top);
    if (bottom) ro.observe(bottom);
    return () => ro.disconnect();
  }, [sessionStatus]);

  // Reset per-session state when navigating between sids so stale events
  // from the previous session's EventSource don't leak into this view.
  useEffect(() => {
    setEvents([]);
    setResolutions(new Map());
    setYoloMode(false);
    setAllowedTools(new Set());
    setPendingMessages([]);
    seenIds.current = new Set();
    stickToBottomRef.current = true;
    prevPendingLenRef.current = 0;
  }, [sid]);

  // Drop optimistic bubbles when the session is no longer live so a
  // mid-turn Stop / subprocess crash doesn't leave a permanent
  // "delivered · awaiting reply" tag on the read-only transcript.
  useEffect(() => {
    if (sessionStatus !== "live") setPendingMessages([]);
  }, [sessionStatus]);

  const addPendingMessage = useCallback((text: string): number => {
    const localId = ++pendingIdSeq.current;
    setPendingMessages((prev) => [
      ...prev,
      { localId, text, sentAt: Date.now() },
    ]);
    return localId;
  }, []);

  const removePendingMessage = useCallback((localId: number) => {
    setPendingMessages((prev) => prev.filter((m) => m.localId !== localId));
  }, []);

  useEffect(() => {
    const ingest = (evt: EnvelopeEvent) => {
      if (seenIds.current.has(evt.id)) return;
      seenIds.current.add(evt.id);
      setEvents((prev) => [...prev, evt]);
      if (evt.type === "permission_resolved") {
        const p = evt.payload as {
          request_id?: string;
          decision?: "allow" | "deny";
        };
        if (p.request_id && p.decision) {
          const requestId = p.request_id;
          const decision = p.decision;
          setResolutions((prev) => {
            if (prev.get(requestId) === decision) return prev;
            const next = new Map(prev);
            next.set(requestId, decision);
            return next;
          });
        }
      }
      if (evt.type === "yolo_mode_changed") {
        const p = evt.payload as { enabled?: unknown };
        if (typeof p.enabled === "boolean") setYoloMode(p.enabled);
      }
      if (evt.type === "tool_allowlisted") {
        const p = evt.payload as { tool_name?: unknown };
        if (typeof p.tool_name === "string") {
          const name = p.tool_name;
          setAllowedTools((prev) => {
            if (prev.has(name)) return prev;
            const next = new Set(prev);
            next.add(name);
            return next;
          });
        }
      }
      // Replayed user input echoed by CC (--replay-user-messages) — drop
      // the matching optimistic bubble so we don't show it twice. For
      // slash commands CC echoes the expanded <command-message> blob, not
      // the original `/name args` invocation, so reconstruct that form
      // and also match on it; otherwise the bubble lingers forever and
      // keeps the thinking indicator stuck on.
      if (evt.type === "user") {
        const p = evt.payload as CCUserPayload;
        const content = p.message?.content;
        if (typeof content === "string") {
          const slash = parseSlashCommand(content);
          // Normalize whitespace so `/foo  bar` (typed) still matches
          // `/foo bar` (reconstructed) — parseSlashCommand collapses
          // inner spacing on its way out.
          const normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();
          const reconstructed = slash
            ? slash.args
              ? `/${slash.name} ${slash.args}`
              : `/${slash.name}`
            : null;
          const normalizedReconstructed =
            reconstructed === null ? null : normalizeWs(reconstructed);
          setPendingMessages((prev) => {
            const idx = prev.findIndex(
              (m) =>
                m.text === content ||
                (normalizedReconstructed !== null &&
                  normalizeWs(m.text) === normalizedReconstructed),
            );
            if (idx === -1) return prev;
            const next = prev.slice();
            next.splice(idx, 1);
            return next;
          });
        }
      }
    };

    if (!inMemory) {
      // Archived-on-disk session: no live stream, one-shot fetch. If the
      // /inbox reconnects later and learns the session is in-memory after
      // all (rare race at server startup), this effect re-runs and upgrades
      // to SSE.
      setStreamStatus("connecting");
      let cancelled = false;
      fetch(`/${encodeURIComponent(sid)}/events`)
        .then((r) => {
          if (!r.ok) throw new Error(`server returned ${r.status}`);
          return r.json() as Promise<{ events: EnvelopeEvent[] }>;
        })
        .then((data) => {
          if (cancelled) return;
          for (const evt of data.events) ingest(evt);
          setStreamStatus("disconnected");
        })
        .catch(() => {
          if (cancelled) return;
          setStreamStatus("disconnected");
        });
      return () => {
        cancelled = true;
      };
    }

    const es = new EventSource(`/${encodeURIComponent(sid)}/stream`);
    es.onopen = () => setStreamStatus("connected");
    es.onerror = () => setStreamStatus("disconnected");
    es.onmessage = (e) => {
      try {
        ingest(JSON.parse(e.data) as EnvelopeEvent);
      } catch {
        // malformed frame; ignore
      }
    };
    return () => es.close();
  }, [sid, inMemory]);

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
  const lastPendingLocalId =
    pendingMessages.length > 0
      ? pendingMessages[pendingMessages.length - 1].localId
      : null;
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
      {canInput && (
        <InputBox
          ref={bottomBarRef}
          sid={sid}
          onSend={addPendingMessage}
          onSendFailed={removePendingMessage}
          canStop={true}
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

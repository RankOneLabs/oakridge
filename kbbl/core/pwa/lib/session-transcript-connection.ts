import { getSessionTranscriptStore, releaseSessionTranscriptStore } from "../state/session-transcript-store";
import type { EpochChanged, ItemPage, SessionWireFrame, Status, TranscriptSeq } from "../types";
import { LiveSubscription } from "./live-stream";
import type { Result } from "./result";
import { applyEpochFrame, applyIncrementalFrames, prependPage } from "./session-frames";

export type LoadEarlierResult = Result<"loaded" | "noop" | "epoch_changed", string>;

export interface SessionTranscriptHandle {
  release(): void;
  reconnect(): void;
  loadEarlier(): Promise<LoadEarlierResult>;
}

const FRAME_KINDS = ["epoch", "item", "item_text", "session_state", "history_truncated", "turn_accepted", "turn_state", "stream_error"] as const;
const NOOP: LoadEarlierResult = { ok: true, value: "noop" };

function parseSessionFrame(event: MessageEvent<string>): SessionWireFrame | null {
  try {
    const payload: SessionWireFrame | null = JSON.parse(event.data);
    if (event.type === "stream_error") {
      // The shared live relay can send errors without a session frame discriminator.
      if (!payload || typeof payload !== "object" || !("error" in payload) || typeof payload.error !== "string") return null;
      return { kind: "stream_error", error: payload.error, code: typeof payload.code === "string" ? payload.code : "stream_error" };
    }
    return payload?.kind === event.type ? payload : null;
  } catch {
    return null;
  }
}

type PageResponse = ItemPage | EpochChanged | { error: string };

function openConnection(sid: string) {
  const store = getSessionTranscriptStore(sid);
  const sessionPath = `/sessions/${encodeURIComponent(sid)}` as const;
  let current: LiveSubscription | null = null;
  let queue: SessionWireFrame[] = [];
  let animationFrame: number | null = null;
  let pageRequest: AbortController | null = null;
  // Reopened items can arrive before the loaded history window.
  let beforeSeq: TranscriptSeq | null = null;

  function clearQueue(): void {
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    queue = [];
  }

  function flush(): void {
    const batch = queue;
    queue = [];
    animationFrame = null;
    store.setState((state) => applyIncrementalFrames(state, batch));
  }

  function setStatus(status: Status): void {
    store.setState(({ connection }) => ({ connection: { ...connection, status } }));
  }

  function connect(): void {
    current?.close();
    clearQueue();
    setStatus("connecting");
    const subscription = new LiveSubscription(`${sessionPath}/stream`);
    current = subscription;
    subscription.onopen = () => {
      if (current === subscription) setStatus("connected");
    };
    subscription.onerror = () => {
      if (current === subscription) setStatus("disconnected");
    };
    for (const kind of FRAME_KINDS) {
      subscription.addEventListener(kind, (event) => {
        if (current !== subscription) return;
        const frame = parseSessionFrame(event);
        if (!frame) return;
        if (frame.kind === "epoch") {
          clearQueue();
          pageRequest?.abort();
          pageRequest = null;
          beforeSeq = frame.items[0]?.seq ?? null;
          store.setState((state) => applyEpochFrame(frame, state));
          return;
        }
        queue.push(frame);
        animationFrame ??= requestAnimationFrame(flush);
      });
    }
  }

  function reviveIfStale(): void {
    if (document.visibilityState === "visible" && current?.readyState === EventSource.CLOSED) connect();
  }

  async function loadEarlier(): Promise<LoadEarlierResult> {
    const state = store.getState();
    const epoch = state.stream_epoch;
    const cursor = beforeSeq;
    if (state.is_loading_earlier || !state.has_earlier || epoch === null || cursor === null) return NOOP;
    const request = new AbortController();
    pageRequest = request;
    store.setState({ is_loading_earlier: true });
    const query = new URLSearchParams({ epoch, before_seq: String(cursor) });
    try {
      const response = await fetch(`${sessionPath}/items?${query}`, { signal: request.signal });
      const text = await response.text();
      if (pageRequest !== request || store.getState().stream_epoch !== epoch) return NOOP;
      let body: PageResponse | null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (typeof body !== "object") body = null;
      if (response.ok && body && "kind" in body && body.kind === "page" && body.stream_epoch === epoch) {
        const page = body;
        beforeSeq = page.items[0]?.seq ?? null;
        store.setState((latest) => ({
          ...prependPage(latest, page.items),
          has_earlier: page.has_earlier,
          is_loading_earlier: false,
        }));
        return { ok: true, value: "loaded" };
      }
      if (response.status === 409 && body && "kind" in body && body.kind === "epoch_changed") {
        beforeSeq = null;
        store.setState(({ connection }) => ({
          stream_epoch: null,
          has_earlier: false,
          is_loading_earlier: false,
          connection: { ...connection, status: "connecting" },
        }));
        connect();
        return { ok: true, value: "epoch_changed" };
      }
      return { ok: false, error: (body && "error" in body ? body.error : text) || response.statusText };
    } catch (error) {
      if (request.signal.aborted) return NOOP;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (pageRequest === request) {
        pageRequest = null;
        if (store.getState().is_loading_earlier) store.setState({ is_loading_earlier: false });
      }
    }
  }

  connect();
  document.addEventListener("visibilitychange", reviveIfStale);
  window.addEventListener("focus", reviveIfStale);

  return {
    readers: 0,
    reconnect: connect,
    loadEarlier,
    close() {
      document.removeEventListener("visibilitychange", reviveIfStale);
      window.removeEventListener("focus", reviveIfStale);
      current?.close();
      current = null;
      clearQueue();
      pageRequest?.abort();
      pageRequest = null;
    },
  };
}

const connections = new Map<string, ReturnType<typeof openConnection>>();

export function acquireSessionTranscript(sid: string): SessionTranscriptHandle {
  const connection = connections.get(sid) ?? openConnection(sid);
  connections.set(sid, connection);
  connection.readers++;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      connection.readers--;
      if (connection.readers > 0) return;
      connection.close();
      connections.delete(sid);
      releaseSessionTranscriptStore(sid);
    },
    reconnect() {
      if (!released) connection.reconnect();
    },
    loadEarlier: () => released ? Promise.resolve(NOOP) : connection.loadEarlier(),
  };
}

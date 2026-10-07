import type { LiveStreamFrame, LiveStreamTopic } from "../../live-stream";

type StreamListener = (event: MessageEvent<string>) => void;
type LifecycleListener = (event: Event) => void;

// One physical EventSource per page. Logical subscriptions retain the existing
// hooks' event names and lifecycles; changing the topics replays their sources.
const subscriptions = new Set<LiveSubscription>();
let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let oakridgeCursor: string | null = null;

function reviveIfStale(): void {
  if (document.visibilityState === "visible" && source?.readyState === EventSource.CLOSED) connect();
}

function connect(): void {
  source?.close();
  source = null;
  if (subscriptions.size === 0) return;
  const topics = [...new Set([...subscriptions].map((subscription) => subscription.topic))].sort();
  const query = new URLSearchParams(topics.map((topic) => ["topic", topic]));
  if (topics.includes("/oakridge/api/events") && oakridgeCursor !== null) query.set("oakridge_cursor", oakridgeCursor);
  const current = new EventSource(`/live?${query}`);
  source = current;
  current.onopen = (event) => {
    if (source !== current) return;
    for (const subscription of subscriptions) subscription.onopen?.(event);
  };
  current.onerror = (event) => {
    if (source !== current) return;
    for (const subscription of subscriptions) subscription.onerror?.(event);
  };
  current.addEventListener("live", (event) => {
    if (source !== current) return;
    let envelope: LiveStreamFrame;
    try {
      envelope = JSON.parse((event as MessageEvent<string>).data) as LiveStreamFrame;
      if (typeof envelope.topic !== "string" || typeof envelope.frame?.event !== "string" || typeof envelope.frame.data !== "string") return;
    } catch { return; }
    if (envelope.topic === "/oakridge/api/events" && envelope.frame.id !== undefined) oakridgeCursor = envelope.frame.id;
    for (const subscription of subscriptions) {
      if (subscription.topic === envelope.topic) subscription.dispatch(envelope);
    }
  });
}

function scheduleConnect(): void {
  if (reconnectTimer !== null) return;
  // Coalesce effect mounts/unmounts when switching routes or opening panes.
  // Close first so old epochs cannot race a newly mounted subscriber.
  source?.close();
  source = null;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 0);
}

export class LiveSubscription {
  onopen: LifecycleListener | null = null;
  onerror: LifecycleListener | null = null;
  private readonly listeners = new Map<string, Set<StreamListener>>();
  private closed = false;

  constructor(readonly topic: LiveStreamTopic) {
    const hadSubscriptions = subscriptions.size > 0;
    subscriptions.add(this);
    if (!hadSubscriptions) {
      document.addEventListener("visibilitychange", reviveIfStale);
      window.addEventListener("focus", reviveIfStale);
    }
    if (hadSubscriptions || reconnectTimer !== null) scheduleConnect();
    else connect();
  }

  get readyState(): number {
    return this.closed ? EventSource.CLOSED : source?.readyState ?? EventSource.CONNECTING;
  }

  addEventListener(name: string, listener: StreamListener): void {
    const listeners = this.listeners.get(name) ?? new Set<StreamListener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: StreamListener): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch({ frame }: LiveStreamFrame): void {
    const event = new MessageEvent<string>(frame.event, { data: frame.data, lastEventId: frame.id ?? "" });
    for (const listener of this.listeners.get(frame.event) ?? []) listener(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    subscriptions.delete(this);
    if (![...subscriptions].some((subscription) => subscription.topic === "/oakridge/api/events")) oakridgeCursor = null;
    if (subscriptions.size === 0) {
      document.removeEventListener("visibilitychange", reviveIfStale);
      window.removeEventListener("focus", reviveIfStale);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      source?.close();
      source = null;
    } else if (![...subscriptions].some((subscription) => subscription.topic === this.topic)) {
      scheduleConnect();
    }
  }
}

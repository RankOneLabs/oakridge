/**
 * In-process pub/sub bus for artifact-scoped SSE events.
 * Keyed by (target_type, target_id). The webhook handler publishes;
 * GET /safir-stream subscribers consume.
 *
 * Replay buffer: last REPLAY_CAP events per channel are kept so a
 * reconnecting client (honoring Last-Event-Id) doesn't miss events
 * that arrived during a brief disconnect.
 */

const REPLAY_CAP = 50;

export interface ArtifactEvent {
  /** Monotonically increasing per channel, used as SSE event id. */
  id: number;
  event: string;
  data: Record<string, unknown>;
  ts: string;
}

type Subscriber = (evt: ArtifactEvent) => void;

function channelKey(targetType: string, targetId: string): string {
  return `${targetType}::${targetId}`;
}

export class ArtifactEventBus {
  private readonly counters = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly replay = new Map<string, ArtifactEvent[]>();

  publish(targetType: string, targetId: string, event: string, data: Record<string, unknown>, ts: string): void {
    const key = channelKey(targetType, targetId);
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);

    const evt: ArtifactEvent = { id: next, event, data, ts };

    // maintain replay buffer
    const buf = this.replay.get(key) ?? [];
    buf.push(evt);
    if (buf.length > REPLAY_CAP) buf.shift();
    this.replay.set(key, buf);

    const subs = this.subscribers.get(key);
    if (subs) {
      for (const fn of subs) {
        fn(evt);
      }
    }
  }

  subscribe(targetType: string, targetId: string, fn: Subscriber): () => void {
    const key = channelKey(targetType, targetId);
    let subs = this.subscribers.get(key);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(key, subs);
    }
    subs.add(fn);
    return () => {
      subs!.delete(fn);
      if (subs!.size === 0) this.subscribers.delete(key);
    };
  }

  /** Returns events with id > since for the given channel. */
  replaySince(targetType: string, targetId: string, since: number): ArtifactEvent[] {
    const key = channelKey(targetType, targetId);
    const buf = this.replay.get(key) ?? [];
    return buf.filter((e) => e.id > since);
  }
}

export const artifactEventBus = new ArtifactEventBus();

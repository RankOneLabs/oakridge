/**
 * In-process pub/sub bus for artifact-scoped SSE events.
 * Keyed by (target_type, target_id). Review publishers publish;
 * GET /artifact-stream subscribers consume.
 *
 * Replay buffer: last REPLAY_CAP events per channel are kept so a
 * reconnecting client (honoring Last-Event-Id) doesn't miss events
 * that arrived during a brief disconnect.
 */

const REPLAY_CAP = 50;

export interface ArtifactEventPayloadByName {
  "atom_edit.applied": {
    id: string;
    target_type: string;
    target_id: string;
    anchor: string | null;
    prior_value: string | null;
    new_value: string;
    author: string;
    created_at: string;
  };
  "thread.created": {
    id: string;
    target_type: string;
    target_id: string;
    anchor: string | null;
    author: string | null;
    status: "open" | "resolved";
    created_at: string;
  };
  "thread.message_added": {
    id: string;
    thread_id: string;
    target_type: string;
    target_id: string;
    author: string;
    body: string;
  };
  "thread.resolved": {
    id: string;
    target_type: string;
    target_id: string;
  };
  "artifact.frozen": {
    target_type: string;
    target_id: string;
  };
  "artifact.reopened": {
    target_type: string;
    target_id: string;
  };
  "thread.ping_received": {
    thread_id: string;
    target_type: string;
    target_id: string;
    anchor: string | null;
    responder_id?: string;
  };
}

export type ArtifactEventName = keyof ArtifactEventPayloadByName;

export interface ArtifactEvent<E extends ArtifactEventName = ArtifactEventName> {
  /** Monotonically increasing per channel, used as SSE event id. */
  id: number;
  event: E;
  data: ArtifactEventPayloadByName[E];
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

  publish<E extends ArtifactEventName>(
    targetType: string,
    targetId: string,
    event: E,
    data: ArtifactEventPayloadByName[E],
    ts: string,
  ): void {
    const key = channelKey(targetType, targetId);
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);

    const evt: ArtifactEvent<E> = { id: next, event, data, ts };

    // maintain replay buffer
    const buf = this.replay.get(key) ?? [];
    buf.push(evt);
    if (buf.length > REPLAY_CAP) buf.shift();
    this.replay.set(key, buf);

    const subs = this.subscribers.get(key);
    if (subs) {
      for (const fn of subs) {
        try { fn(evt); } catch (err) {
          console.error(JSON.stringify({ kbbl: "artifact_bus_subscriber_error", error: String(err) }));
        }
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

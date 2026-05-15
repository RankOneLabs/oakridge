export class EventBus<T> {
  private readonly subscribers = new Map<keyof T, Set<(payload: unknown) => void>>();

  subscribe<K extends keyof T>(event: K, handler: (payload: T[K]) => void): () => void {
    let subs = this.subscribers.get(event);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(event, subs);
    }
    const fn = handler as (payload: unknown) => void;
    subs.add(fn);
    return () => {
      subs!.delete(fn);
      if (subs!.size === 0 && this.subscribers.get(event) === subs) {
        this.subscribers.delete(event);
      }
    };
  }

  emit<K extends keyof T>(event: K, payload: T[K]): void {
    const subs = this.subscribers.get(event);
    if (!subs) return;
    for (const fn of [...subs]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(JSON.stringify({ kbbl: "event_bus_subscriber_error", event: String(event), error: String(err) }));
      }
    }
  }
}

export interface SharedCursorOptions {
  readonly ttl_ms?: number;
  readonly now?: () => number;
}

/** How long a freshly read cursor may serve later callers before being re-read. */
const DEFAULT_CURSOR_TTL_MS = 250;

/**
 * Collapse every SSE client's cursor poll onto one query.
 *
 * The invalidation cursor is seven `max()` reads, and it was executed once per
 * poll interval *per connected client* — so N operators watching the dashboard
 * multiplied the same seven reads by N, every second, forever. The value is
 * global: every client is asking for exactly the same string, so one read can
 * answer all of them.
 *
 * Concurrent callers share the in-flight query rather than queueing behind each
 * other, and a result stays servable for a short window so clients whose poll
 * intervals have drifted apart still coalesce. A rejection is delivered to its
 * callers and caches nothing, so the next poll retries rather than serving a
 * stale cursor forever.
 */
export const sharedCursor = (read: () => Promise<string>, options: SharedCursorOptions = {}): (() => Promise<string>) => {
  const ttlMs = options.ttl_ms ?? DEFAULT_CURSOR_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let inFlight: Promise<string> | null = null;
  let cached: { readonly value: string; readonly read_at: number } | null = null;

  return () => {
    const current = cached;
    if (current && now() - current.read_at < ttlMs) return Promise.resolve(current.value);
    const existing = inFlight;
    if (existing) return existing;
    const request = read().then(
      (value) => { cached = { value, read_at: now() }; inFlight = null; return value; },
      (cause: unknown) => { inFlight = null; throw cause; },
    );
    inFlight = request;
    return request;
  };
};

import type { Hono } from "hono";

import type { SessionManager } from "../../session/session-manager";

/**
 * Wire envelope safir sends on every webhook delivery.
 * Mirror of personal/safir/src/api/webhooks.ts WebhookEnvelope; copied
 * verbatim rather than imported so kbbl is buildable without the safir
 * package on disk and a safir-side schema change becomes a visible test
 * failure here instead of a silent wire mismatch.
 */
type SafirWebhookEvent =
  | "run.created"
  | "run.status_changed"
  | "run.completed"
  | "run.failed"
  | "phase.handoff_submitted";

interface SafirWebhookEnvelope {
  event: SafirWebhookEvent;
  ts: string;
  delivery_id: string;
  data: Record<string, unknown>;
}

/**
 * In-memory LRU keyed by delivery_id. Capacity 1000 matches plan §3.4.
 * On restart the cache is empty — that is acceptable because safir's
 * retry budget caps at 5 attempts per delivery and the LRU only protects
 * against the within-session duplicate case (a re-delivery during the
 * same kbbl uptime). If a duplicate slips through across a restart, the
 * dispatch is idempotent in practice (re-emitting a `safir_event` to a
 * still-matching session is harmless) and the operator will see two
 * lines in the session JSONL — visible, not catastrophic.
 */
const LRU_CAPACITY = 1000;

class DeliveryIdLru {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  has(id: string): boolean {
    return this.seen.has(id);
  }

  add(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > LRU_CAPACITY) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }
}

export interface SafirWebhookRouteDeps {
  manager: SessionManager;
  /**
   * Override only for tests that need to assert behavior across a fresh
   * LRU per case. Production callers omit this and get the module-level
   * singleton.
   */
  lru?: DeliveryIdLru;
}

const moduleLru = new DeliveryIdLru();

/**
 * Constant-time compare so a token-mismatch handler can't be timing-side-
 * channeled into revealing prefix length. Both args are short ASCII
 * tokens; a `===` would be fine in practice but the constant-time
 * version is cheap and self-documenting that this path is auth.
 */
function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Routes that dispatch a known event to a matching live session emit a
 * `safir_event` envelope event onto the session's stream. Type is
 * lower-snake-case to match existing kbbl envelope-event naming
 * (session_started, usage_observation, etc.).
 */
const DISPATCHABLE_EVENTS: ReadonlySet<SafirWebhookEvent> = new Set([
  "run.completed",
  "run.failed",
]);

export function mountSafirWebhookRoutes(
  app: Hono,
  deps: SafirWebhookRouteDeps,
): void {
  const { manager, lru = moduleLru } = deps;

  app.post("/webhooks/safir", async (c) => {
    const expected = process.env.SAFIR_WEBHOOK_TOKEN;
    if (!expected || expected.trim() === "") {
      // No configured token = the receiver is not provisioned. Refuse all
      // calls so a misconfigured deploy fails closed, not silently open.
      return c.json({ error: "webhook receiver not configured" }, 401);
    }
    const supplied = parseBearer(c.req.header("authorization"));
    if (!supplied || !tokensEqual(supplied, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return c.json({ error: "json body must be an object" }, 400);
    }
    const env = raw as Partial<SafirWebhookEnvelope>;
    if (typeof env.event !== "string" || env.event.trim() === "") {
      return c.json({ error: "event must be a non-empty string" }, 400);
    }
    if (typeof env.delivery_id !== "string" || env.delivery_id.trim() === "") {
      return c.json({ error: "delivery_id must be a non-empty string" }, 400);
    }
    if (typeof env.data !== "object" || env.data === null || Array.isArray(env.data)) {
      return c.json({ error: "data must be an object" }, 400);
    }

    if (lru.has(env.delivery_id)) {
      // Idempotent ack. Do NOT 409: safir treats non-2xx as retry, so a
      // 409 would cause the same delivery to keep firing until safir
      // exhausts its retry budget.
      return c.json({ ok: true, deduped: true });
    }
    lru.add(env.delivery_id);

    const event = env.event as SafirWebhookEvent;
    const data = env.data as Record<string, unknown>;

    if (DISPATCHABLE_EVENTS.has(event)) {
      const runId = typeof data.run_id === "string" ? data.run_id : null;
      if (runId !== null) {
        const session = manager.findLiveByRunId(runId);
        if (session) {
          await session.emit("safir_event", {
            event,
            ts: env.ts,
            delivery_id: env.delivery_id,
            data,
          });
          return c.json({ ok: true, dispatched: true });
        }
      }
    }
    // Unknown event type, missing run_id, or no live-session match.
    // Log structured line so the operator can grep for it; still ack 200.
    console.log(
      JSON.stringify({
        kbbl: "safir_webhook_drop",
        event,
        delivery_id: env.delivery_id,
        reason:
          !DISPATCHABLE_EVENTS.has(event)
            ? "event_not_dispatched_in_pr_c"
            : typeof data.run_id !== "string"
              ? "missing_run_id"
              : "no_live_session_match",
      }),
    );
    return c.json({ ok: true, dispatched: false });
  });
}

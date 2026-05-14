import type { Hono } from "hono";

import type { SessionManager } from "../../session/session-manager";
import type { ReviewResponderDispatchDeps } from "./review-responder-consumer";
import { dispatchReviewResponder } from "./review-responder-consumer";
import type { ArtifactEventBus } from "../../stream/artifact-event-bus";

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
  | "build_brief.submitted"
  | "plan.created"
  | "atom_edit.applied"
  | "comment_thread.created"
  | "thread.message_added"
  | "thread.status_changed"
  | "artifact.status_changed"
  | "artifact.reopened"
  | "thread.agent_response_started"
  | "thread.agent_response_completed"
  | "thread.agent_response_failed";

interface SafirWebhookEnvelope {
  event: SafirWebhookEvent;
  ts: string;
  delivery_id: string;
  data: Record<string, unknown>;
}

/**
 * Bounded FIFO dedupe set keyed by delivery_id. Capacity 1000 matches
 * plan §3.4. Insertion-order eviction (not true LRU — recency is not
 * tracked on `has` lookups) is sufficient because safir's retry budget
 * caps at 5 attempts per delivery and dedupe only protects the
 * within-uptime duplicate case. On restart the set is empty; if a
 * duplicate slips through across a restart, the dispatch is idempotent
 * in practice (re-emitting a `safir_event` to a still-matching session
 * is harmless) and the operator will see two lines in the session
 * JSONL — visible, not catastrophic.
 */
const DEDUPE_CAPACITY = 1000;

class DeliveryIdDedupe {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  has(id: string): boolean {
    return this.seen.has(id);
  }

  add(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > DEDUPE_CAPACITY) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }
}

/** Events that spawn a review-responder subprocess. */
const RESPONDER_EVENTS: ReadonlySet<SafirWebhookEvent> = new Set([
  "thread.agent_response_started",
]);

export interface SafirWebhookRouteDeps {
  manager: SessionManager;
  /**
   * Override only for tests that need to assert behavior across a fresh
   * dedupe set per case. Production callers omit this and get the
   * module-level singleton.
   */
  dedupe?: DeliveryIdDedupe;
  /**
   * Dependencies for the review-responder consumer. Required for
   * thread.agent_response_started events to be dispatched; omit in tests
   * that only cover session-fan-out events.
   */
  reviewResponder?: ReviewResponderDispatchDeps;
  /**
   * Artifact event bus for SSE fan-out to PWA plan/build-brief reviewers.
   * Omit in tests that only cover session-based fan-out.
   */
  artifactBus?: ArtifactEventBus;
}

const moduleDedupe = new DeliveryIdDedupe();

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
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Every event safir is known to send. Mirrors `SafirWebhookEvent` so
 * unrecognized values can be split out from the drop-log as a distinct
 * `event_unknown` reason — that's the surface schema drift would show up
 * on (e.g. safir adds `phase.created` and forgets to update kbbl). Kept
 * as a runtime Set rather than derived from the type so a missed entry
 * here trips a typecheck failure on the type alias change.
 */
const KNOWN_EVENTS: ReadonlySet<SafirWebhookEvent> = new Set([
  "run.created",
  "run.status_changed",
  "run.completed",
  "run.failed",
  "build_brief.submitted",
  "plan.created",
  "atom_edit.applied",
  "comment_thread.created",
  "thread.message_added",
  "thread.status_changed",
  "artifact.status_changed",
  "artifact.reopened",
  "thread.agent_response_started",
  "thread.agent_response_completed",
  "thread.agent_response_failed",
]);

/**
 * Events that fan out to live sessions as `safir_event` envelope events.
 * Run-scoped events dispatch by run_id; artifact-scoped events dispatch by
 * (target_type, target_id) via the ArtifactEventBus.
 */
const DISPATCHABLE_EVENTS: ReadonlySet<SafirWebhookEvent> = new Set([
  "run.completed",
  "run.failed",
]);

/**
 * Artifact-scoped events that are broadcast on the ArtifactEventBus so the
 * PWA plan / build-brief reviewer SSE streams receive them.
 * Excludes `thread.agent_response_started` — consumed only by the
 * review-responder subprocess (RESPONDER_EVENTS), not the PWA.
 */
const ARTIFACT_BUS_EVENTS: ReadonlySet<SafirWebhookEvent> = new Set([
  "atom_edit.applied",
  "comment_thread.created",
  "thread.message_added",
  "thread.status_changed",
  "artifact.status_changed",
  "artifact.reopened",
  "plan.created",
  "thread.agent_response_completed",
  "thread.agent_response_failed",
]);

export function mountSafirWebhookRoutes(
  app: Hono,
  deps: SafirWebhookRouteDeps,
): void {
  const { manager, dedupe = moduleDedupe } = deps;

  app.post("/webhooks/safir", async (c) => {
    const expectedRaw = process.env.SAFIR_WEBHOOK_TOKEN;
    if (!expectedRaw || expectedRaw.trim() === "") {
      // No configured token = the receiver is not provisioned. Refuse all
      // calls so a misconfigured deploy fails closed, not silently open.
      return c.json({ error: "webhook receiver not configured" }, 401);
    }
    // Trim before comparing so a stray trailing newline or space in the
    // env var (common when set via `printf "%s\n" ... > .env`) doesn't
    // 401 every otherwise-valid request.
    const expected = expectedRaw.trim();
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
    const envIn = raw as Partial<SafirWebhookEnvelope>;
    if (typeof envIn.event !== "string" || envIn.event.trim() === "") {
      return c.json({ error: "event must be a non-empty string" }, 400);
    }
    if (typeof envIn.delivery_id !== "string" || envIn.delivery_id.trim() === "") {
      return c.json({ error: "delivery_id must be a non-empty string" }, 400);
    }
    if (typeof envIn.ts !== "string" || envIn.ts.trim() === "") {
      return c.json({ error: "ts must be a non-empty string" }, 400);
    }
    if (typeof envIn.data !== "object" || envIn.data === null || Array.isArray(envIn.data)) {
      return c.json({ error: "data must be an object" }, 400);
    }
    // Use trimmed values for everything downstream so a stray trailing
    // space or newline (e.g. `"run.completed "`) doesn't pass validation
    // and then mismatch DISPATCHABLE_EVENTS / change the dedupe key.
    const event = envIn.event.trim() as SafirWebhookEvent;
    const deliveryId = envIn.delivery_id.trim();
    const ts = envIn.ts.trim();
    const data = envIn.data as Record<string, unknown>;

    if (dedupe.has(deliveryId)) {
      // Idempotent ack. Do NOT 409: safir treats non-2xx as retry, so a
      // 409 would cause the same delivery to keep firing until safir
      // exhausts its retry budget.
      return c.json({ ok: true, deduped: true });
    }

    if (DISPATCHABLE_EVENTS.has(event)) {
      const runId = typeof data.run_id === "string" ? data.run_id : null;
      if (runId !== null) {
        // Fan out to every live session attached to this run. `create()`
        // permits multiple sessions to share a runId (one phase each), so
        // a run-scoped event like `run.completed` is meaningful to all of
        // them. Emit sequentially; if any throw, propagate so safir
        // retries — dedupe is recorded only on full success below.
        const sessions = manager.findAllLiveByRunId(runId);
        if (sessions.length > 0) {
          for (const session of sessions) {
            await session.emit("safir_event", {
              event,
              ts,
              delivery_id: deliveryId,
              data,
            });
          }
          dedupe.add(deliveryId);
          return c.json({ ok: true, dispatched: true });
        }
      }
    }

    if (ARTIFACT_BUS_EVENTS.has(event) && deps.artifactBus) {
      // Extract (target_type, target_id) from the event payload.
      // Most artifact events carry these directly; plan.created maps plan_id.
      // agent_response_completed/failed carry only thread_id — skip bus
      // dispatch for those (thread.message_added carries full context).
      let targetType: string | null = null;
      let targetId: string | null = null;

      if (event === "plan.created") {
        targetType = "plan";
        targetId = typeof data.plan_id === "string" ? data.plan_id : null;
      } else {
        targetType = typeof data.target_type === "string" ? data.target_type : null;
        targetId = typeof data.target_id === "string" ? data.target_id : null;
      }

      if (targetType !== null && targetId !== null) {
        deps.artifactBus.publish(targetType, targetId, event, data, ts);
        dedupe.add(deliveryId);
        return c.json({ ok: true, dispatched: true });
      }
    }

    if (RESPONDER_EVENTS.has(event)) {
      if (!deps.reviewResponder) {
        console.error(
          JSON.stringify({
            kbbl: "safir_webhook_drop",
            event,
            delivery_id: deliveryId,
            reason: "review_responder_deps_missing",
          }),
        );
        dedupe.add(deliveryId);
        return c.json({ ok: true, dispatched: false });
      } else {
        // Fire-and-forget: the responder is slow (LLM calls) and safir only
        // needs a 200 ack that we received the event. The responder reports
        // its own completion via POST /threads/:id/agent-response.
        dispatchReviewResponder(data, deps.reviewResponder).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            JSON.stringify({
              kbbl: "review_responder_unhandled_error",
              event,
              delivery_id: deliveryId,
              error: msg,
            }),
          );
        });
        dedupe.add(deliveryId);
        return c.json({ ok: true, dispatched: true });
      }
    }

    // Unknown event type, missing run_id, or no live-session match.
    // Log structured line so the operator can grep for it; still ack 200
    // (a non-2xx would burn safir's per-delivery retry budget without
    // changing the outcome). stderr matches kbbl's other operational
    // logs (server.ts, session.ts). The reason split distinguishes a
    // safir-side typo / new-event drift (`event_unknown`) from a
    // known-but-not-yet-dispatched event (`event_not_dispatched_in_pr_c`)
    // so operators can alert on drift without alerting on the latter.
    console.error(
      JSON.stringify({
        kbbl: "safir_webhook_drop",
        event,
        delivery_id: deliveryId,
        reason:
          !KNOWN_EVENTS.has(event)
            ? "event_unknown"
            : !DISPATCHABLE_EVENTS.has(event) && !ARTIFACT_BUS_EVENTS.has(event) && !RESPONDER_EVENTS.has(event)
              ? "event_not_dispatched_in_pr_c"
              : typeof data.run_id !== "string"
                ? "missing_run_id"
                : "no_live_session_match",
      }),
    );
    dedupe.add(deliveryId);
    return c.json({ ok: true, dispatched: false });
  });
}

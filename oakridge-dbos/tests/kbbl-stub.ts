/**
 * A kbbl stand-in that keeps kbbl's actual wire contract, because the contract
 * is where the original session defect hid.
 *
 * Two details are the whole point of this file and must not be "simplified":
 *
 *  - `PUT /sessions/resumable/:sessionKey` takes a *session key* and answers
 *    with kbbl's own generated `sid`. The key and the sid are different
 *    identifiers. Echoing the key back as the sid passes a naive stub and then
 *    strands the run, because `GET /sessions/resumable/:sid/terminal` validates
 *    its segment against `SID_PATTERN` (a v4 UUID) and never matches a key.
 *  - Hono decodes path params. A stub that splits `URL.pathname` without
 *    decoding sees the percent-encoded segment, so a key containing `:` is
 *    stored under `%3A` and looked up under `%253A` — a silent double-encode
 *    that reads as "the session never becomes terminal".
 *
 * Mirrors `toTerminalBody` in `kbbl/core/server/handlers/sessions.ts`.
 */
import { SID_PATTERN } from "../../kbbl/core/server/handlers/acp-per-sid";

/** What the stub should report for a session once it is observed. */
export type StubOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly code: string; readonly detail: string }
  /** Never becomes terminal on its own; only a fence ends it. */
  | { readonly kind: "pending" };

/** The subset of kbbl's start body these tests route on. */
export interface StubStartBody {
  readonly initial_prompt: string;
  readonly workdir: string;
  readonly name: string;
  readonly runtime: string;
  readonly workflow: {
    readonly workflow_run_id: string;
    readonly stage_instance_id: string;
    readonly unit_id: string;
    readonly cohort_id?: string;
    readonly operator_role?: string;
  };
}

export interface StubSession {
  readonly sid: string;
  readonly session_key: string;
  readonly unit_id: string;
  /** The owning scope instance. */
  readonly stage_instance_id: string;
  /** The selected worker key; `operator_role` on the wire. */
  readonly worker: string;
  readonly start_body: StubStartBody;
  outcome: StubOutcome;
  /** Set by a fence (DELETE); reported as `user_closed`, which DBOS reads as cancellation. */
  fenced: boolean;
  /** Observation count, so a test can assert a session was polled rather than guessed at. */
  observations: number;
}

export interface StubRequestLog {
  readonly method: string;
  readonly path: string;
}

/** Decides each session's outcome from its start body. Defaults to success. */
export type StubPolicy = (body: StubStartBody) => StubOutcome;

/** Identifies one selected session: the owning scope and its worker. */
export interface SessionSelector {
  readonly scope_id: string;
  readonly worker: string;
}

export interface KbblStub {
  readonly url: string;
  /** Live sessions by kbbl sid. */
  readonly sessions: ReadonlyMap<string, StubSession>;
  readonly requests: readonly StubRequestLog[];
  /** The most recent session for a selector; a retry starts a new one. */
  session_for(selector: SessionSelector): StubSession | null;
  sessions_for(selector: SessionSelector): readonly StubSession[];
  all(): readonly StubSession[];
  /** Flips a pending session to a terminal outcome mid-run. */
  settle(selector: SessionSelector, outcome: StubOutcome): void;
  stop(): void;
}

function legacySnapshot(session: StubSession, status: string, end_reason: string | null): unknown {
  return { sid: session.sid, status, endReason: end_reason, worktreeBaseRef: null,
    lastActivityTs: new Date().toISOString() };
}

function terminalBody(session: StubSession): unknown {
  // A fence wins over the session's own outcome: DBOS keys cancellation off
  // `user_closed`, exactly as kbbl's `toTerminalBody` does.
  if (session.fenced) return { session: legacySnapshot(session, "ended", "user_closed"), exit_code: 1 };
  const outcome = session.outcome;
  if (outcome.kind === "succeeded") return { session: legacySnapshot(session, "ended", null), exit_code: 0 };
  if (outcome.kind === "pending") throw new Error("terminalBody called for a pending session");
  return { session: legacySnapshot(session, "ended", "subprocess_exited"), exit_code: 1,
    failure: { code: outcome.code, detail: outcome.detail } };
}

function isStartBody(value: unknown): value is StubStartBody {
  if (!value || typeof value !== "object") return false;
  const body = value as { initial_prompt?: unknown; workdir?: unknown; workflow?: unknown };
  if (typeof body.initial_prompt !== "string" || typeof body.workdir !== "string") return false;
  const workflow = body.workflow;
  if (!workflow || typeof workflow !== "object") return false;
  const identity = workflow as { unit_id?: unknown; stage_instance_id?: unknown };
  return typeof identity.unit_id === "string" && typeof identity.stage_instance_id === "string";
}

/**
 * Starts the stub on an ephemeral port. `policy` is consulted once per session
 * key, when the session is first ensured.
 */
export function startKbblStub(policy: StubPolicy = () => ({ kind: "succeeded" })): KbblStub {
  const sessions = new Map<string, StubSession>();
  const by_key = new Map<string, string>();
  const requests: StubRequestLog[] = [];

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const url = new URL(request.url);
    // Decode exactly as Hono's `c.req.param` does; see the header comment.
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0).map(decodeURIComponent);
    requests.push({ method: request.method, path: url.pathname });

    // PUT /sessions/resumable/:sessionKey — ensure (start or attach).
    if (request.method === "PUT" && segments.length === 3 && segments[0] === "sessions" && segments[1] === "resumable") {
      const session_key = segments[2]!;
      if (session_key.length === 0 || session_key.length > 300) return Response.json({ error: "session key must be 1-300 characters" }, { status: 400 });
      let body: unknown;
      try { body = await request.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
      if (!isStartBody(body)) return Response.json({ error: "initial_prompt must be a non-empty string" }, { status: 400 });
      const existing_sid = by_key.get(session_key);
      if (existing_sid) {
        const attached = sessions.get(existing_sid)!;
        return Response.json({ kind: "attached", session: legacySnapshot(attached, "live", null) });
      }
      // kbbl mints its own sid; it is never the session key.
      const sid = crypto.randomUUID();
      const session: StubSession = { sid, session_key, unit_id: body.workflow.unit_id,
        stage_instance_id: body.workflow.stage_instance_id, worker: body.workflow.operator_role ?? "",
        start_body: body, outcome: policy(body), fenced: false, observations: 0 };
      sessions.set(sid, session);
      by_key.set(session_key, sid);
      return Response.json({ kind: "started", session: legacySnapshot(session, "live", null) });
    }

    // GET /sessions/resumable/:sid/terminal — observe.
    if (request.method === "GET" && segments.length === 4 && segments[0] === "sessions" && segments[1] === "resumable" && segments[3] === "terminal") {
      const sid = segments[2]!;
      if (!SID_PATTERN.test(sid)) return Response.json({ error: "invalid sid" }, { status: 400 });
      const session = sessions.get(sid);
      if (!session) return Response.json({ error: "session not found" }, { status: 404 });
      session.observations += 1;
      if (!session.fenced && session.outcome.kind === "pending") {
        return Response.json({ pending: true, session: legacySnapshot(session, "live", null) }, { status: 202 });
      }
      return Response.json(terminalBody(session));
    }

    // PUT /sessions/resumable/:sid/input/:deliveryKey — feedback delivery.
    if (request.method === "PUT" && segments.length === 5 && segments[0] === "sessions" && segments[1] === "resumable" && segments[3] === "input") {
      const sid = segments[2]!;
      if (!SID_PATTERN.test(sid)) return Response.json({ error: "invalid sid" }, { status: 400 });
      if (!sessions.has(sid)) return Response.json({ error: "session not found" }, { status: 404 });
      return Response.json({ delivered: true });
    }

    // DELETE /sessions/:sid?fenced_by=... — cancel or fence.
    if (request.method === "DELETE" && segments.length === 2 && segments[0] === "sessions") {
      const sid = segments[1]!;
      if (!SID_PATTERN.test(sid)) return Response.json({ error: "invalid sid" }, { status: 400 });
      const session = sessions.get(sid);
      // A fence of a session kbbl no longer holds is not an error; the run is
      // tearing down and the agent is already gone.
      if (session) session.fenced = true;
      return Response.json({ stopped: true });
    }

    // `/` is the composition's session-provider probe.
    if (segments.length === 0) return Response.json({ status: "ok" });
    return Response.json({ error: "not found" }, { status: 404 });
  } });

  const matching = (selector: SessionSelector): readonly StubSession[] =>
    [...sessions.values()].filter((session) =>
      session.stage_instance_id === selector.scope_id && session.worker === selector.worker);

  return {
    url: server.url.href,
    sessions,
    requests,
    session_for(selector) { const found = matching(selector); return found[found.length - 1] ?? null; },
    sessions_for(selector) { return matching(selector); },
    all() { return [...sessions.values()]; },
    settle(selector, outcome) {
      const found = matching(selector);
      if (found.length === 0) throw new Error(`no stub session for ${selector.worker} on ${selector.scope_id}`);
      // Only the live attempt is settled; an earlier attempt stays as it ended.
      found[found.length - 1]!.outcome = outcome;
    },
    stop() { server.stop(true); },
  };
}

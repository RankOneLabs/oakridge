import { createHash } from "node:crypto";

/**
 * A stub kbbl: the resumable session routes the agent provider calls,
 * in memory, with each delivered task run by a scripted agent. An agent
 * publishes the way a real one does, from what its session was given: the
 * endpoint and secret in the preamble, the predecessor and subject in the task.
 */

export interface StubTurn {
  readonly session_key: string;
  readonly sid: string;
  readonly delivery_key: string;
  /** The session's preamble, as its ensure carried it. */
  readonly preamble: string;
  readonly task: string;
  /** Publish a revision through the backend's publish route, with this session's secret. */
  publish(artifact: string, body: unknown, options?: { readonly predecessor?: string | null; readonly subject?: string | null }): Promise<Response>;
  /** The current revision the task names for an artifact; null when it has none. */
  predecessor(artifact: string): string | null;
  /** The revision the task asks this agent to review; null when none. */
  subject(): string | null;
}
/** What a turn ends as; a script that throws ends it failed. */
export type TurnEnd = "succeeded" | "failed";
export type AgentScript = (turn: StubTurn) => Promise<TurnEnd>;

export interface StubInput { readonly delivery_key: string; readonly text: string; status: "accepted" | "prompting" | "succeeded" | "failed" | "cancelled" }
export interface StubSession {
  readonly sid: string;
  readonly session_key: string;
  readonly spec: { readonly initial_prompt: string; readonly workdir: string; readonly worktree?: { readonly branch_name: string; readonly base_ref?: string } };
  status: "live" | "ended" | "fenced";
  readonly inputs: StubInput[];
  readonly closes: (string | null)[];
}

export interface StubKbbl {
  readonly url: string;
  readonly sessions: Map<string, StubSession>;
  /** Ensure calls per session key, and sessions created per key: a key created twice is a duplicate start. */
  readonly ensures: Map<string, number>;
  readonly creates: Map<string, number>;
  /** The most tasks that were running at once. */
  readonly max_running: () => number;
  sessionsFor(predicate: (session: StubSession) => boolean): StubSession[];
  stop(): void;
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const snapshot = (session: StubSession) => ({ sid: session.sid, status: session.status === "live" ? "live" : "ended",
  lastActivityTs: new Date().toISOString() });

export function startStubKbbl(script: AgentScript): StubKbbl {
  const sessions = new Map<string, StubSession>();
  const by_key = new Map<string, { readonly sid: string; readonly spec_digest: string }>();
  const ensures = new Map<string, number>();
  const creates = new Map<string, number>();
  let running = 0;
  let max_running = 0;

  function turnOf(session: StubSession, input: StubInput): StubTurn {
    const preamble = session.spec.initial_prompt;
    const secret = /Your publication secret: (\S+)/.exec(preamble)?.[1] ?? "";
    const endpoint = (artifact: string): string => {
      const match = new RegExp(`- \`${artifact}\`\\n  endpoint: (\\S+)`).exec(preamble);
      if (!match?.[1]) throw new Error(`the preamble names no endpoint for ${artifact}`);
      return match[1];
    };
    return {
      session_key: session.session_key, sid: session.sid, delivery_key: input.delivery_key, preamble, task: input.text,
      publish: (artifact, body, options = {}) => fetch(endpoint(artifact), { method: "PUT",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ request_id: crypto.randomUUID(), body, predecessor: options.predecessor ?? null, subject: options.subject ?? null }) }),
      predecessor: (artifact) => new RegExp(`- \`${artifact}\`: current revision \`([^\`]+)\``).exec(input.text)?.[1] ?? null,
      subject: () => /You are reviewing revision `([^`]+)`/.exec(input.text)?.[1] ?? null,
    };
  }
  async function runTurn(session: StubSession, input: StubInput): Promise<void> {
    input.status = "prompting";
    running += 1;
    max_running = Math.max(max_running, running);
    let end: TurnEnd;
    try { end = await script(turnOf(session, input)); } catch { end = "failed"; }
    running -= 1;
    if (input.status === "prompting") input.status = end;
  }

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method === "PUT" && parts[0] === "sessions" && parts[1] === "resumable" && parts.length === 3) {
      const key = parts[2]!;
      const spec = await request.json() as StubSession["spec"];
      ensures.set(key, (ensures.get(key) ?? 0) + 1);
      const claimed = by_key.get(key);
      if (claimed) {
        if (claimed.spec_digest !== digest(spec)) return Response.json({ error: "spec conflict", code: "session_key_conflict" }, { status: 409 });
        const session = sessions.get(claimed.sid)!;
        if (session.status === "ended" && request.headers.get("x-oakridge-collaboration-resume") === "true") session.status = "live";
        return Response.json({ kind: session.status === "live" ? "attached" : "terminal", session: snapshot(session) });
      }
      const session: StubSession = { sid: crypto.randomUUID(), session_key: key, spec, status: "live", inputs: [], closes: [] };
      sessions.set(session.sid, session);
      by_key.set(key, { sid: session.sid, spec_digest: digest(spec) });
      creates.set(key, (creates.get(key) ?? 0) + 1);
      return Response.json({ kind: "started", session: snapshot(session) }, { status: 201 });
    }
    if (request.method === "PUT" && parts[0] === "sessions" && parts[1] === "resumable" && parts[3] === "input") {
      const session = sessions.get(parts[2]!);
      if (!session || session.status !== "live") return Response.json({ error: "session is ended", code: "session_not_found" }, { status: 404 });
      const { text } = await request.json() as { readonly text: string };
      const delivery_key = parts[4]!;
      const existing = session.inputs.find((input) => input.delivery_key === delivery_key);
      if (existing) return existing.text === text ? Response.json({ accepted: true, delivery_key, status: existing.status })
        : Response.json({ error: "delivery key reused", code: "delivery_key_conflict" }, { status: 409 });
      const input: StubInput = { delivery_key, text, status: "accepted" };
      session.inputs.push(input);
      void runTurn(session, input);
      return Response.json({ accepted: true, delivery_key, status: input.status });
    }
    if (request.method === "GET" && parts[0] === "sessions" && parts[1] === "resumable" && parts[3] === "terminal") {
      const session = sessions.get(parts[2]!);
      if (!session) return Response.json({ error: "no session", code: "session_not_found" }, { status: 404 });
      return Response.json({ session: snapshot(session), end: session.status === "live" ? { kind: "succeeded" } : { kind: "closed" } });
    }
    if (request.method === "DELETE" && parts[0] === "sessions" && parts.length === 2) {
      const session = sessions.get(parts[1]!);
      if (!session) return Response.json({ error: "unknown session" }, { status: 404 });
      const fenced_by = url.searchParams.get("fenced_by");
      session.closes.push(fenced_by);
      if (session.status === "live") session.status = fenced_by ? "fenced" : "ended";
      for (const input of session.inputs) if (input.status === "accepted" || input.status === "prompting") input.status = "cancelled";
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  } });

  return {
    url: `http://127.0.0.1:${server.port}`, sessions, ensures, creates, max_running: () => max_running,
    sessionsFor: (predicate) => [...sessions.values()].filter(predicate),
    stop: () => { void server.stop(true); },
  };
}

/** Resolves once `condition` holds, polling; fails with `label` after `timeout_ms`. */
export async function eventually<Value>(label: string, condition: () => Promise<Value | null | undefined | false>, timeout_ms = 30_000): Promise<Value> {
  const deadline = Date.now() + timeout_ms;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(50);
  }
}

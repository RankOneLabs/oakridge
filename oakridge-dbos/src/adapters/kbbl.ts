import type { JsonValue } from "../domain/primitives";
import type { ProviderResult } from "../effects/provider";
import type { ResumableEnsureRequest, ResumableEnsureResponse, ResumableInputRequest, ResumableSessionStatus } from "../../../kbbl/core/acp/resumable-wire";

/**
 * kbbl's resumable session routes (§11 of the kbbl contract), as the agent
 * provider uses them. Every call is idempotent by its key: an ensure by
 * session key, an input by delivery key. Transport failures and 5xx answers
 * are uncertain or transient; any other refusal is permanent.
 */

/**
 * The header that lets an ensure revive an ended session under its key
 * (part 1 §7.2). Without it kbbl answers `terminal` for an ended session, and
 * a revise delivered to it has nothing live to reach.
 */
export const REVIVE_HEADER = "x-oakridge-collaboration-resume";

/**
 * How long a session may report no activity at all before it is called dead.
 *
 * Not a cap on how long an agent may work: `lastActivityTs` moves on every
 * event a session produces, so a busy agent never approaches it. It bounds a
 * session that will never take its turn, which kbbl truthfully reports as not
 * finished forever. Generous on purpose, because a long silent tool call (a
 * full test suite, a slow build) looks the same from outside.
 */
export const DEFAULT_MAX_SILENT_MS = 30 * 60_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface KbblClientOptions {
  readonly base_url: string;
  readonly fetch?: FetchLike;
}

/** The part of a resumable session snapshot the provider reads. */
export interface KbblSession {
  readonly sid: string;
  readonly status: ResumableSessionStatus;
  readonly last_activity_ts: string | null;
}
export interface EnsuredSession { readonly kind: ResumableEnsureResponse["kind"]; readonly session: KbblSession }
/** A delivered input's turn, as kbbl's keyed receipt reports it. */
export type TurnStatus = "accepted" | "prompting" | "succeeded" | "cancelled" | "failed" | "unknown";
export interface TurnReceipt { readonly status: TurnStatus }
/** A session as its terminal route reports it: still on its first turn, or ended with a reason. */
export type SessionReading =
  | { readonly kind: "pending"; readonly session: KbblSession }
  | { readonly kind: "ended"; readonly session: KbblSession; readonly end: SessionEnd };
export type SessionEnd =
  | { readonly kind: "succeeded" }
  | { readonly kind: "closed" }
  | { readonly kind: "failed"; readonly code: string; readonly detail: string };

type Fields = { readonly [key: string]: unknown };
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const SESSION_STATUSES: readonly ResumableSessionStatus[] = ["starting", "live", "ended"];
const TURN_STATUSES = ["accepted", "prompting", "succeeded", "cancelled", "failed", "unknown"] as const;

function parseSession(value: unknown): KbblSession | null {
  if (!isFields(value) || typeof value.sid !== "string") return null;
  const status = SESSION_STATUSES.find((candidate) => candidate === value.status);
  if (!status) return null;
  return { sid: value.sid, status, last_activity_ts: typeof value.lastActivityTs === "string" ? value.lastActivityTs : null };
}

/**
 * How a terminal body says the session ended. Any non-empty failure code is
 * kept, so a code a newer kbbl adds still reaches the attempt.
 */
function parseEnd(raw: unknown): SessionEnd | null {
  if (!isFields(raw)) return null;
  if (raw.kind === "succeeded") return { kind: "succeeded" };
  if (raw.kind === "closed") return { kind: "closed" };
  if (raw.kind !== "failed" || typeof raw.code !== "string" || raw.code === "") return null;
  return { kind: "failed", code: raw.code, detail: typeof raw.detail === "string" && raw.detail !== "" ? raw.detail : raw.code };
}

/**
 * How long a session has been silent, or null when the reading carries no
 * parseable activity time: an unknown time is not silence.
 */
export const silentDurationMs = (pending: JsonValue, now: number): number | null => {
  if (!isFields(pending) || !isFields(pending.session)) return null;
  const last_activity = pending.session.lastActivityTs;
  if (typeof last_activity !== "string") return null;
  const observed_at = Date.parse(last_activity);
  return Number.isNaN(observed_at) ? null : Math.max(0, now - observed_at);
};

/** The attempt closing its own session, and whether the session ends for good. */
export interface SessionCloser { readonly action_id: string; readonly is_fence: boolean }

export class KbblClient {
  private readonly fetch: FetchLike;
  private readonly base_url: string;
  constructor(options: KbblClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.base_url = options.base_url.replace(/\/+$/, "");
  }

  /** One HTTP call; transport failures are uncertain, 5xx/408/429 transient, other refusals permanent. */
  private async call<Value>(operation: string, url: string, init: RequestInit, read: (response: Response) => Promise<Value | null>,
    signal: AbortSignal | undefined): Promise<ProviderResult<Value>> {
    let response: Response;
    try { response = await this.fetch(url, { ...init, ...(signal ? { signal } : {}) }); }
    catch (error) { return { kind: "uncertain", detail: `kbbl ${operation}: ${String(error)}` }; }
    if (!response.ok && response.status !== 202) {
      const detail = `kbbl ${operation} failed (${response.status}): ${await response.text().catch(() => "")}`;
      return response.status >= 500 || response.status === 408 || response.status === 429
        ? { kind: "transiently_unavailable", detail } : { kind: "permanently_rejected", code: "kbbl_refused", detail };
    }
    let value: Value | null;
    try { value = await read(response); } catch (error) { return { kind: "uncertain", detail: `kbbl ${operation}: ${String(error)}` }; }
    return value === null ? { kind: "uncertain", detail: `kbbl ${operation} returned an unreadable body` } : { kind: "acknowledged", value };
  }

  /** PUT /sessions/resumable/:key, reviving an ended session under the key. The same key and spec reach the same session. */
  ensure(session_key: string, body: ResumableEnsureRequest, signal?: AbortSignal): Promise<ProviderResult<EnsuredSession>> {
    return this.call("ensure", `${this.base_url}/sessions/resumable/${encodeURIComponent(session_key)}`, {
      method: "PUT", headers: { "content-type": "application/json", [REVIVE_HEADER]: "true" }, body: JSON.stringify(body),
    }, async (response) => {
      const raw: unknown = await response.json();
      if (!isFields(raw) || (raw.kind !== "attached" && raw.kind !== "started" && raw.kind !== "terminal")) return null;
      const session = parseSession(raw.session);
      return session ? { kind: raw.kind, session } : null;
    }, signal);
  }

  /**
   * PUT /sessions/resumable/:sid/input/:delivery_key. A repeat with the same
   * text returns the first delivery's receipt, so this is also how the
   * delivered turn is observed.
   */
  deliver(sid: string, delivery_key: string, text: string, signal?: AbortSignal): Promise<ProviderResult<TurnReceipt>> {
    return this.call("input", `${this.base_url}/sessions/resumable/${encodeURIComponent(sid)}/input/${encodeURIComponent(delivery_key)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text } satisfies ResumableInputRequest),
    }, async (response) => {
      const raw: unknown = await response.json();
      const status = isFields(raw) ? TURN_STATUSES.find((candidate) => candidate === raw.status) : undefined;
      return status ? { status } : null;
    }, signal);
  }

  /** GET /sessions/resumable/:sid/terminal without waiting: the session's activity, and how it ended if it has. */
  read(sid: string, signal?: AbortSignal): Promise<ProviderResult<SessionReading>> {
    return this.call("read", `${this.base_url}/sessions/resumable/${encodeURIComponent(sid)}/terminal?wait_ms=0`, { method: "GET" }, async (response) => {
      const raw: unknown = await response.json();
      if (!isFields(raw)) return null;
      const session = parseSession(raw.session);
      if (!session) return null;
      if (response.status === 202) return { kind: "pending", session };
      const end = parseEnd(raw.end);
      return end ? { kind: "ended", session, end } : null;
    }, signal);
  }

  /**
   * DELETE /sessions/:sid, as the attempt that holds the session, so kbbl's
   * hold guard lets it through. A fence ends the session for good; otherwise
   * it stays revivable under its key. An unknown session is already stopped.
   */
  async close(sid: string, closer: SessionCloser, signal?: AbortSignal): Promise<ProviderResult<{ readonly stopped: true }>> {
    const query = `?${closer.is_fence ? "fenced_by" : "closed_by"}=${encodeURIComponent(closer.action_id)}`;
    let response: Response;
    try { response = await this.fetch(`${this.base_url}/sessions/${encodeURIComponent(sid)}${query}`, { method: "DELETE", ...(signal ? { signal } : {}) }); }
    catch (error) { return { kind: "uncertain", detail: `kbbl close: ${String(error)}` }; }
    if (response.ok || response.status === 404) return { kind: "acknowledged", value: { stopped: true } };
    const detail = `kbbl close failed (${response.status}): ${await response.text().catch(() => "")}`;
    return response.status >= 500 ? { kind: "transiently_unavailable", detail } : { kind: "permanently_rejected", code: "kbbl_refused", detail };
  }
}

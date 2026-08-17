import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeId } from "../runtime";
import type { SessionId, SessionSnapshot } from "./types";

export type ResumableSessionKey = string & { readonly __brand: "ResumableSessionKey" };

export interface ResumableSessionStartSpec {
  readonly initial_prompt: string;
  readonly workdir: string;
  readonly name?: string;
  readonly artifact_id?: string;
  readonly runtime?: RuntimeId;
  readonly model?: string;
  readonly effort?: string;
  readonly worktree?: {
    readonly branch_name: string;
    readonly worktree_subdir: string;
    readonly base_ref?: string;
  };
  readonly inherit_worktree_from?: SessionId;
}

export interface ResumableSessionClaim {
  readonly version: 1;
  readonly session_key: ResumableSessionKey;
  readonly session_id: SessionId;
  readonly generation: number;
  readonly start_spec_hash: string;
  readonly created_at: string;
}

export type EnsureResumableSessionResult =
  | { readonly kind: "attached"; readonly session: SessionSnapshot }
  | { readonly kind: "started"; readonly session: SessionSnapshot }
  | { readonly kind: "terminal"; readonly session: SessionSnapshot };

/** Outcome of forcing a key past a session it can no longer safely resume. */
export type AdvanceResumableSessionResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "advanced"; readonly previous_session_id: SessionId; readonly session_id: SessionId; readonly generation: number };

export interface ResumableSessionTerminalResult {
  readonly session: SessionSnapshot;
  readonly exit_code: number | null;
}

/**
 * The result of one bounded wait for a resumable session to end. Observers poll
 * with a deadline that stays well inside the HTTP transport's own timeout, so a
 * still-running session answers `pending` rather than holding a socket open for
 * the life of the agent.
 */
export type ResumableSessionTerminalOutcome =
  | { readonly kind: "terminal"; readonly result: ResumableSessionTerminalResult }
  | { readonly kind: "pending" }
  | { readonly kind: "not_found" };

/** Bounds for the `wait_ms` query parameter on the terminal-observation route. */
export const TERMINAL_WAIT_MS_DEFAULT = 25_000;
export const TERMINAL_WAIT_MS_MAX = 60_000;

export const selectTerminalWaitMs = (raw: string | undefined): number => {
  if (raw === undefined) return TERMINAL_WAIT_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return TERMINAL_WAIT_MS_DEFAULT;
  return Math.min(Math.trunc(parsed), TERMINAL_WAIT_MS_MAX);
};

export type ResumableInputDeliveryKey = string & { readonly __brand: "ResumableInputDeliveryKey" };
export interface ResumableInputReceipt {
  readonly version: 1;
  readonly delivery_key: ResumableInputDeliveryKey;
  readonly payload_hash: string;
  readonly status: "queued" | "delivered";
  readonly created_at: string;
  readonly delivered_at: string | null;
}

export class ResumableInputConflictError extends Error {
  constructor(readonly delivery_key: ResumableInputDeliveryKey) {
    super(`input delivery key '${delivery_key}' was already accepted with different text`);
    this.name = "ResumableInputConflictError";
  }
}

export class SessionKeyConflictError extends Error {
  constructor(readonly session_key: ResumableSessionKey) {
    super(`session key '${session_key}' was already claimed with a different start spec`);
    this.name = "SessionKeyConflictError";
  }
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const startSpecHash = (spec: ResumableSessionStartSpec): string => sha256(JSON.stringify(stableValue(spec)));

export const sessionIdForKey = (key: ResumableSessionKey, generation = 0): SessionId => {
  const hex = sha256(`${key}:${generation}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}` as SessionId;
};

const parseClaim = (raw: string): ResumableSessionClaim => {
  const value = JSON.parse(raw) as Partial<ResumableSessionClaim>;
  if (value.version !== 1 || typeof value.session_key !== "string" || typeof value.session_id !== "string" || typeof value.generation !== "number" || typeof value.start_spec_hash !== "string" || typeof value.created_at !== "string") {
    throw new Error("invalid resumable session claim");
  }
  return value as ResumableSessionClaim;
};

export class FilesystemResumableSessionClaims {
  constructor(private readonly sessions_dir: string) {}

  async claim(session_key: ResumableSessionKey, start_spec: ResumableSessionStartSpec): Promise<{ readonly claim: ResumableSessionClaim; readonly is_new: boolean }> {
    const claims_dir = join(this.sessions_dir, "execution-claims");
    await mkdir(claims_dir, { recursive: true });
    const claim_dir = join(claims_dir, sha256(session_key));
    const claim_path = join(claim_dir, "claim.json");
    const expected_hash = startSpecHash(start_spec);
    await mkdir(claim_dir, { recursive: true });
    const candidate: ResumableSessionClaim = { version: 1, session_key, session_id: sessionIdForKey(session_key), generation: 0, start_spec_hash: expected_hash, created_at: new Date().toISOString() };
    try {
      await writeFile(claim_path, `${JSON.stringify(candidate)}\n`, { flag: "wx" });
      return { claim: candidate, is_new: true };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
    const existing = parseClaim(await readFile(claim_path, "utf8"));
    if (existing.session_key !== session_key || existing.start_spec_hash !== expected_hash) throw new SessionKeyConflictError(session_key);
    return { claim: existing, is_new: false };
  }

  async read(session_key: ResumableSessionKey): Promise<ResumableSessionClaim | null> {
    const claim_path = join(this.sessions_dir, "execution-claims", sha256(session_key), "claim.json");
    try { return parseClaim(await readFile(claim_path, "utf8")); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Move the key to its next generation. Compare-and-swap on the claim the
   * caller read, so two callers racing to advance the same generation produce
   * one new session rather than two. Used both when an orphan has been fenced
   * and when an operator forces a wedged key forward.
   */
  async advance(claim: ResumableSessionClaim): Promise<ResumableSessionClaim> {
    const claim_dir = join(this.sessions_dir, "execution-claims", sha256(claim.session_key));
    const claim_path = join(claim_dir, "claim.json");
    const current = parseClaim(await readFile(claim_path, "utf8"));
    if (current.session_id !== claim.session_id || current.generation !== claim.generation) return current;
    const next: ResumableSessionClaim = {
      ...current,
      session_id: sessionIdForKey(current.session_key, current.generation + 1),
      generation: current.generation + 1,
    };
    const temporary_path = join(claim_dir, `claim.${crypto.randomUUID()}.tmp`);
    await writeFile(temporary_path, `${JSON.stringify(next)}\n`, { flag: "wx" });
    await rename(temporary_path, claim_path);
    return next;
  }
}

const parseInputReceipt = (raw: string): ResumableInputReceipt => {
  const value = JSON.parse(raw) as Partial<ResumableInputReceipt>;
  if (value.version !== 1 || typeof value.delivery_key !== "string" || typeof value.payload_hash !== "string" || (value.status !== "queued" && value.status !== "delivered") || typeof value.created_at !== "string" || (value.delivered_at !== null && typeof value.delivered_at !== "string")) throw new Error("invalid resumable input receipt");
  return value as ResumableInputReceipt;
};

export class FilesystemResumableInputInbox {
  constructor(private readonly sessions_dir: string) {}

  private receiptPath(delivery_key: ResumableInputDeliveryKey): string {
    return join(this.sessions_dir, "execution-inputs", sha256(delivery_key), "receipt.json");
  }

  async enqueue(delivery_key: ResumableInputDeliveryKey, text: string): Promise<ResumableInputReceipt> {
    const receipt_path = this.receiptPath(delivery_key);
    await mkdir(join(this.sessions_dir, "execution-inputs", sha256(delivery_key)), { recursive: true });
    const candidate: ResumableInputReceipt = { version: 1, delivery_key, payload_hash: sha256(text), status: "queued", created_at: new Date().toISOString(), delivered_at: null };
    try { await writeFile(receipt_path, `${JSON.stringify(candidate)}\n`, { flag: "wx" }); return candidate; }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
    const existing = parseInputReceipt(await readFile(receipt_path, "utf8"));
    if (existing.delivery_key !== delivery_key || existing.payload_hash !== candidate.payload_hash) throw new ResumableInputConflictError(delivery_key);
    return existing;
  }

  async markDelivered(receipt: ResumableInputReceipt): Promise<ResumableInputReceipt> {
    if (receipt.status === "delivered") return receipt;
    const delivered: ResumableInputReceipt = { ...receipt, status: "delivered", delivered_at: new Date().toISOString() };
    const receipt_path = this.receiptPath(receipt.delivery_key);
    const temporary_path = `${receipt_path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary_path, `${JSON.stringify(delivered)}\n`, { flag: "wx" });
    await rename(temporary_path, receipt_path);
    return delivered;
  }
}

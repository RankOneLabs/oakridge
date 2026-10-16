import { createHash, createHmac } from "node:crypto";
import type { KbblClient, KbblSession } from "../adapters/kbbl";
import { DEFAULT_MAX_SILENT_MS } from "../adapters/kbbl";
import type { EffectInstruction } from "../domain/effect-instruction";
import type { ResumableEnsureRequest } from "../../../kbbl/core/acp/resumable-wire";
import type { EffectProvider, ProviderResult, TerminalObservation } from "./provider";
import { HANDLE_KINDS, PROVIDER_ERROR_CODES } from "./provider-catalog";
import { renderSessionPreamble, renderSharedTaskDelivery } from "./session-prompt";

/**
 * The publication secret of one kbbl session (part 1 §7.2): derived from the
 * session key, so every ensure of the session (a crash retry, another engine
 * version, a later attempt resuming it) sends the same preamble, and kbbl's
 * keyed ensure stays idempotent. It is never stored; the attempt keeps only
 * its hash, which is how publish resolves its writer.
 */
export function derivePublicationSecret(publication_key: string, session_key: string): string {
  return createHmac("sha256", publication_key).update(`oakridge-publication\0${session_key}`).digest("base64url");
}
/** The form an attempt stores and publish compares: sha256 hex of the secret. */
export const publicationSecretHash = (secret: string): string => createHash("sha256").update(secret).digest("hex");
/** The kbbl delivery key of an attempt's task: fixed-length, since an action id grows with its unit's path and kbbl caps keys at 300. */
export const selectDeliveryKey = (instruction: EffectInstruction): string =>
  createHash("sha256").update(`${instruction.attempt.action_id}\0${instruction.attempt.seq}`).digest("hex");

/** The repository a `repository(<expr>)` workspace names, as `repository.prepare` publishes it. */
export interface AgentWorkspace { readonly repository_path: string; readonly head: string }
export function selectAgentWorkspace(workspace: unknown): AgentWorkspace | null {
  if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) return null;
  const { repository_path, head } = workspace as { readonly [key: string]: unknown };
  return typeof repository_path === "string" && repository_path !== "" && typeof head === "string" && head !== ""
    ? { repository_path, head } : null;
}

export interface AgentProviderConfig {
  /** Null when no kbbl is configured: every agent start is then refused with `kbbl_unconfigured`. */
  readonly kbbl: KbblClient | null;
  /** HMAC key for publication secrets; required beside kbbl. */
  readonly publication_key: string | null;
  /** The backend as agents reach it: they publish to it directly, since the kbbl proxy does not forward the secret. */
  readonly publish_base_url: string;
  /** Where a session with `workspace: none` runs. */
  readonly default_workdir: string;
  readonly max_silent_ms?: number;
  /** Injectable clock, so a test can prove the silence bound without waiting it out. */
  readonly now?: () => number;
}

const KBBL_NAME_LIMIT = 80;
const shortDigest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * The ensure a session is started with. Everything in it is fixed for the
 * session (unit, worker, created artifacts, workspace, secret), so every
 * attempt that resumes the session sends the same spec. A repository
 * workspace gets its own worktree, branched from the prepared head on a
 * branch named for the session.
 */
export function selectSessionStart(instruction: EffectInstruction, config: Pick<AgentProviderConfig, "publish_base_url" | "default_workdir">,
  secret: string): ResumableEnsureRequest {
  const worker = instruction.worker;
  if (worker.kind !== "agent") throw new Error(`instruction ${instruction.attempt.action_id} is not an agent's`);
  const workspace = selectAgentWorkspace(instruction.workspace);
  const session_unit = worker.shared_session_unit ?? instruction.action.unit;
  const session_path = session_unit.startsWith(`${instruction.run_id}/`) ? session_unit.slice(instruction.run_id.length + 1) : session_unit;
  const name = `${instruction.action.worker} · ${session_path}`;
  return {
    initial_prompt: renderSessionPreamble({ run_id: instruction.run_id, unit: session_unit, worker: instruction.action.worker,
      creates: worker.creates, schemas: worker.schemas, publish_base_url: config.publish_base_url, secret,
      shared: worker.session === "shared" }),
    workdir: workspace?.repository_path ?? config.default_workdir,
    name: name.length > KBBL_NAME_LIMIT ? `${name.slice(0, KBBL_NAME_LIMIT - 1)}…` : name,
    ...(worker.settings ? { runtime: worker.settings.harness, model: worker.settings.model,
      ...(worker.settings.effort === null ? {} : { effort: worker.settings.effort }) } : {}),
    ...(workspace ? { worktree: { branch_name: `oakridge/${shortDigest(worker.session_key)}`, worktree_subdir: "oakridge", base_ref: workspace.head } } : {}),
    workflow: { run_id: instruction.run_id, unit_id: session_unit, worker: instruction.action.worker },
  };
}

const failed = (code: string, detail: string): ProviderResult<TerminalObservation> =>
  ({ kind: "acknowledged", value: { kind: "terminal", result: { kind: "failed", code, detail } } });

/** The production agent path: one kbbl resumable session per session key, one keyed input per attempt. */
export function createAgentProvider(config: AgentProviderConfig): EffectProvider {
  const unconfigured = { kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.kbbl_unconfigured,
    detail: "agent workers need KBBL_BASE_URL and OAKRIDGE_PUBLICATION_KEY" } as const;
  const max_silent_ms = config.max_silent_ms ?? DEFAULT_MAX_SILENT_MS;
  const now = config.now ?? Date.now;

  async function ensure(instruction: EffectInstruction, signal: AbortSignal | undefined) {
    if (!config.kbbl || config.publication_key === null || instruction.worker.kind !== "agent") return null;
    const secret = derivePublicationSecret(config.publication_key, instruction.worker.session_key);
    const ensured = await config.kbbl.ensure(instruction.worker.session_key, selectSessionStart(instruction, config, secret), signal);
    return { ensured, secret };
  }
  /** A session that cannot take input: how it ended, as kbbl reports it. */
  async function ended(kbbl: KbblClient, sid: string, refusal: string, signal: AbortSignal | undefined): Promise<ProviderResult<TerminalObservation>> {
    const reading = await kbbl.read(sid, signal);
    if (reading.kind === "transiently_unavailable" || reading.kind === "uncertain") return reading;
    if (reading.kind === "acknowledged" && reading.value.kind === "ended") {
      const end = reading.value.end;
      if (end.kind === "closed") return failed(PROVIDER_ERROR_CODES.session_closed, `kbbl session ${sid} was closed before its task finished`);
      if (end.kind === "failed") return failed(end.code, `kbbl session ${sid} failed: ${end.detail}`);
    }
    return failed(PROVIDER_ERROR_CODES.session_failed, refusal);
  }
  /**
   * Bounds a turn that never makes progress: kbbl truthfully reports it as
   * unfinished forever. A silent session may still be running, so silence
   * refuses the observation rather than ending the attempt: the carrier then
   * stops the session, and a later revise does not find it busy.
   */
  async function silence(kbbl: KbblClient, sid: string, signal: AbortSignal | undefined): Promise<ProviderResult<TerminalObservation>> {
    const reading = await kbbl.read(sid, signal);
    // A failed read is not activity: it counts toward the observation's unavailable bound.
    if (reading.kind !== "acknowledged") return reading.kind === "permanently_rejected"
      ? { kind: "transiently_unavailable", detail: reading.detail } : reading;
    const session: KbblSession = reading.value.session;
    const last = session.last_activity_ts ? Date.parse(session.last_activity_ts) : Number.NaN;
    const silent_for = Number.isNaN(last) ? null : Math.max(0, now() - last);
    if (silent_for !== null && silent_for > max_silent_ms) return { kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.executor_silent_timeout,
      detail: `kbbl session ${sid} reported no activity for ${Math.round(silent_for / 1000)}s (limit ${Math.round(max_silent_ms / 1000)}s)` };
    return { kind: "acknowledged", value: { kind: "running" } };
  }

  return {
    async start(instruction, options = {}) {
      const started = await ensure(instruction, options.signal);
      if (!started) return unconfigured;
      const { ensured, secret } = started;
      if (ensured.kind !== "acknowledged") return ensured.kind === "permanently_rejected"
        ? { kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.start_rejected, detail: ensured.detail } : ensured;
      // With the revive header an ended session comes back live; one still ended was fenced and cannot resume.
      if (ensured.value.session.status === "ended") return { kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.session_closed,
        detail: `kbbl session ${ensured.value.session.sid} under this key has ended and cannot be revived` };
      return { kind: "acknowledged", value: { handle: { kind: HANDLE_KINDS.session, session_id: ensured.value.session.sid },
        publication_secret_hash: publicationSecretHash(secret) } };
    },

    async observe(instruction, material, handle, options = {}) {
      const kbbl = config.kbbl;
      if (!kbbl) return unconfigured;
      const task = instruction.worker.kind === "agent" && instruction.worker.session === "shared" && config.publication_key !== null
        ? renderSharedTaskDelivery(instruction, material.task, { publish_base_url: config.publish_base_url,
          secret: derivePublicationSecret(config.publication_key, instruction.worker.session_key) }) : material.task;
      const receipt = await kbbl.deliver(handle.session_id, selectDeliveryKey(instruction), task, options.signal);
      if (receipt.kind === "permanently_rejected") return ended(kbbl, handle.session_id, receipt.detail, options.signal);
      if (receipt.kind !== "acknowledged") return receipt;
      switch (receipt.value.status) {
        case "succeeded": return { kind: "acknowledged", value: { kind: "terminal", result: { kind: "succeeded" } } };
        case "failed": case "unknown": case "cancelled":
          return failed(PROVIDER_ERROR_CODES.session_failed, `the task's turn in kbbl session ${handle.session_id} ended ${receipt.value.status}`);
        case "accepted": case "prompting": return silence(kbbl, handle.session_id, options.signal);
      }
    },

    async stop(instruction, handle, options = {}) {
      const kbbl = config.kbbl;
      if (instruction.worker.kind !== "agent") return { kind: "acknowledged", value: { stopped: true } };
      // Without kbbl a session started earlier cannot be proven stopped: the stop stays owed until kbbl is back.
      if (!kbbl || config.publication_key === null) return { kind: "transiently_unavailable", detail: unconfigured.detail };
      let session_id = handle?.session_id ?? null;
      if (session_id === null) {
        // A start whose answer was lost may still have opened the session: the same ensure finds it.
        const started = await ensure(instruction, options.signal);
        if (!started) return { kind: "transiently_unavailable", detail: unconfigured.detail };
        if (started.ensured.kind !== "acknowledged") return { kind: "uncertain", detail: `cannot find the session to stop: ${started.ensured.detail}` };
        session_id = started.ensured.value.session.sid;
      }
      // A fresh session belongs to this attempt alone and is fenced; a resumed one is closed, so a later attempt can revive it.
      return kbbl.close(session_id, { action_id: instruction.attempt.action_id, is_fence: instruction.worker.session === "fresh" }, options.signal);
    },
  };
}

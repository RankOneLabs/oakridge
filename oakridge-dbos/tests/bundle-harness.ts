/**
 * Drives a shipped bundle through the PRODUCTION composition.
 *
 * Nothing here substitutes an effect provider or a result schema. The run is
 * advanced by the real DBOS run workflow, sessions are started by the real
 * session provider against `kbbl-stub`'s kbbl contract, and outputs are
 * published through the same token-authenticated execution route a real agent
 * uses. The only injected seams are the two outside-world edges a test cannot
 * own: the kbbl HTTP endpoint and the GitHub pull-request reader.
 *
 * A fixture override — `result_schema` in particular — is what hid the original
 * session defect behind a green suite, so this harness has none.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createProductionComposition, type ProductionComposition } from "../src/runtime/compose";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { PullRequestObservation } from "../src/domain/pull-request";
import type { EffectPayload } from "../src/effects/intents";
import type { PullRequestReader } from "../src/runtime/github-pull-requests";
import type { ScopeId, ScopeInstanceRecord } from "../src/storage/schema-records";
import { unsealEffectPayload } from "../src/storage/effect-secret";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { startKbblStub, type KbblStub, type StubOutcome, type StubPolicy, type StubSession } from "./kbbl-stub";

export const CORE_BINARY = resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli");

/** The three shipped bundles. `development-verification` carries the distinct pool limit. */
export const SHIPPED_BUNDLES = ["development", "development-independent-siblings", "development-verification"] as const;
export type ShippedBundle = (typeof SHIPPED_BUNDLES)[number];

export interface HarnessScope extends ScopeInstanceRecord { readonly id: ScopeId }

export const revisionOf = (id: string) => ({ brand: "artifact_revision", id });

export function localRepository(label: string): string {
  const path = mkdtempSync(resolve(tmpdir(), `oakridge-${label}-`));
  for (const args of [["init"],
    ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"],
    ["remote", "add", "origin", "https://github.com/owner/repo.git"]]) {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: path, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString()}`);
  }
  return path;
}

export async function loadBundle(name: ShippedBundle): Promise<DefinitionBundle> {
  return Bun.file(resolve(import.meta.dir, `../../workflow-config/definitions/${name}.json`)).json();
}

export interface PullRequestState {
  state: "open" | "merged" | "closed";
  head_sha: string;
  merged_at: string | null;
}

/**
 * One pull request per head branch. The `pr_observer` action queries by the
 * branch its scope published, so keying on branch is what keeps sibling
 * cohorts from sharing a pull-request state.
 */
export class PullRequests {
  private readonly states = new Map<string, PullRequestState>();

  state(branch: string): PullRequestState {
    const existing = this.states.get(branch);
    if (existing) return existing;
    const fresh: PullRequestState = { state: "open", head_sha: "head1", merged_at: null };
    this.states.set(branch, fresh);
    return fresh;
  }
  merge(branch: string): void {
    const state = this.state(branch);
    state.state = "merged";
    state.merged_at = "2026-10-07";
  }
  reopen(branch: string): void {
    const state = this.state(branch);
    state.state = "open";
    state.merged_at = null;
  }
}

/** A branch's stable pull-request identity, so an accept target can match it. */
export function pullRequestNumber(branch: string): number {
  let hash = 0;
  for (const character of branch) hash = (hash * 31 + character.charCodeAt(0)) % 9973;
  return hash + 1;
}
export const pullRequestUrl = (branch: string) => `https://github.com/owner/repo/pull/${pullRequestNumber(branch)}`;

/** The forge observation shape the `pr_observed` fact is built from. */
export function observation(branch: string, pr: PullRequestState): PullRequestObservation {
  return { provider: "github", owner: "owner", name: "repo", number: pullRequestNumber(branch),
    url: pullRequestUrl(branch), head_branch: branch, base_branch: "cohort",
    head_sha: pr.head_sha, state: pr.state, source: "forge", observed_at: "2026-10-07",
    merged_at: pr.merged_at } as unknown as PullRequestObservation;
}

export interface HarnessOptions {
  readonly bundle: ShippedBundle;
  readonly database_url: string;
  readonly db: TransactionalSqlExecutor;
  readonly label: string;
  readonly policy?: StubPolicy;
  /** Extra run input members, e.g. `development-verification`'s note. */
  readonly input_extra?: Record<string, unknown>;
  readonly repositories?: readonly string[];
  /**
   * Reuse an already-running stub and repository paths instead of creating
   * them. Used to rebuild a composition over a run a killed process left.
   */
  readonly reuse?: ReuseTarget;
}

/** An existing run and the stub its sessions already registered with. */
export interface ReuseTarget {
  readonly kbbl: KbblStub;
  readonly run_id: string;
  readonly root_scope_id: string;
  readonly repository_paths: ReadonlyMap<string, string>;
  readonly pull_requests: PullRequests;
}

export interface Harness {
  readonly composition: ProductionComposition;
  readonly kbbl: KbblStub;
  readonly run_id: string;
  readonly root_scope_id: string;
  readonly bundle: DefinitionBundle;
  readonly pull_requests: PullRequests;
  readonly repository_paths: ReadonlyMap<string, string>;
  scope(id?: string): Promise<HarnessScope>;
  children(scope_key: string): Promise<readonly HarnessScope[]>;
  child(child_key: string, scope_key?: string): Promise<HarnessScope>;
  awaitChild(scope_key: string, child_key?: string): Promise<HarnessScope>;
  command(scope_id: string, key: string, payload?: unknown): Promise<Response>;
  requireCommand(scope_id: string, key: string, payload?: unknown): Promise<void>;
  /** Waits for the selected execution of `worker`, publishes, returns its revision id. */
  publish(scope_id: string, worker: string, output_key: string, body: unknown, member?: string): Promise<string>;
  awaitSession(scope_id: string, worker: string): Promise<StubSession>;
  awaitTerminalExecution(scope_id: string): Promise<void>;
  awaitState(scope_id: string, variant: string): Promise<void>;
  awaitTerminalScope(scope_id: string): Promise<HarnessScope>;
  /** Flips a pending session to a terminal outcome, as an agent exiting would. */
  settle(scope_id: string, worker: string, outcome?: StubOutcome): void;
  close(): Promise<void>;
}

const POLL_MS = 40;

export async function eventually<T>(read: () => Promise<T | null | undefined>, label: string, budget_ms = 30_000): Promise<T> {
  const deadline = Date.now() + budget_ms;
  let last: unknown = null;
  for (;;) {
    try { const value = await read(); if (value !== null && value !== undefined) return value; }
    catch (error) { last = error; }
    if (Date.now() >= deadline) throw new Error(`timed out awaiting ${label}${last ? `: ${String(last)}` : ""}`);
    await Bun.sleep(POLL_MS);
  }
}

/** Sessions start pending so the test can publish before the agent "exits". */
export const pendingSessions: StubPolicy = () => ({ kind: "pending" });

export async function startHarness(options: HarnessOptions): Promise<Harness> {
  const { db } = options;
  const bundle = await loadBundle(options.bundle);
  const repository_keys = options.repositories ?? ["repo"];
  const repository_paths = options.reuse?.repository_paths
    ?? new Map(repository_keys.map((key) => [key, localRepository(`${options.label}-${key}`)]));
  const pull_requests_state = options.reuse?.pull_requests ?? new PullRequests();
  const kbbl = options.reuse?.kbbl ?? startKbblStub(options.policy ?? pendingSessions);

  const pull_requests: PullRequestReader = {
    read: async (_owner, _name, number) => {
      const branch = ["work", "work-first", "work-second", "work-third", "work-fourth"]
        .find((candidate) => pullRequestNumber(candidate) === number);
      return { ok: true, value: branch ? observation(branch, pull_requests_state.state(branch)) : null };
    },
    find_for_branches: async (query) => ({ ok: true,
      value: [observation(query.head_branch, pull_requests_state.state(query.head_branch))] }),
  };

  const composition = await createProductionComposition({
    database_url: options.database_url, core_binary: CORE_BINARY, host: "127.0.0.1",
    kbbl_base_url: kbbl.url, pull_requests,
    provider_capabilities: { probe: async () => ({ ok: true as const, value: true as const }),
      check_github: async () => ({ ok: true as const, value: true as const }) },
    timing: { observe_interval_seconds: 0.05, wake_timeout_seconds: 1 },
  });

  const session_config = (key: string) => ({ runtime: "codex", workdir: repository_paths.get(key)!, session_name: `${options.label}-${key}` });
  const repositories = repository_keys.map((key) => ({ key,
    preparation: { repository_path: repository_paths.get(key)!, expected_head: null },
    build: session_config(key), integration: session_config(key),
    forge: { owner: "owner", name: key === "repo" ? "repo" : key, build_base: "cohort", final_base: "main" } }));
  const root_session = session_config(repository_keys[0]!);
  const input = { spec: "Feature", repositories, analysis: root_session, planning: root_session, briefs: root_session,
    ...(options.input_extra ?? {}) };

  let run: { run_id: string; root_scope_id: string };
  if (options.reuse) {
    run = { run_id: options.reuse.run_id, root_scope_id: options.reuse.root_scope_id };
  } else {
    const created = await composition.app.request("/runs", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle, input }) });
    if (created.status !== 201) { await composition.close(); kbbl.stop(); throw new Error(`run not created: ${created.status} ${await created.text()}`); }
    run = await created.json();
  }

  const scope = async (id: string = run.root_scope_id): Promise<HarnessScope> => {
    const rows = await db.query<HarnessScope>("SELECT * FROM authority.scope_instance WHERE id=$1", [id]);
    if (!rows[0]) throw new Error(`scope missing: ${id}`);
    return rows[0];
  };
  const children = async (scope_key: string): Promise<readonly HarnessScope[]> =>
    db.query<HarnessScope>("SELECT * FROM authority.scope_instance WHERE run_id=$1 AND scope_key=$2 ORDER BY child_key",
      [run.run_id, scope_key]);
  const child = async (child_key: string, scope_key?: string): Promise<HarnessScope> => {
    const rows = await db.query<HarnessScope>(
      `SELECT * FROM authority.scope_instance WHERE run_id=$1 AND child_key=$2${scope_key ? " AND scope_key=$3" : ""} LIMIT 1`,
      scope_key ? [run.run_id, child_key, scope_key] : [run.run_id, child_key]);
    if (!rows[0]) throw new Error(`child missing: ${child_key}`);
    return rows[0];
  };
  const awaitChild = (scope_key: string, child_key?: string) => eventually(async () => {
    const rows = await db.query<HarnessScope>(
      `SELECT * FROM authority.scope_instance WHERE run_id=$1 AND scope_key=$2${child_key ? " AND child_key=$3" : ""} LIMIT 1`,
      child_key ? [run.run_id, scope_key, child_key] : [run.run_id, scope_key]);
    return rows[0] ?? null;
  }, `child ${scope_key}${child_key ? `/${child_key}` : ""}`);

  const command = async (scope_id: string, key: string, payload: unknown = {}): Promise<Response> => {
    const path = `/api/runs/${run.run_id}/scopes/${scope_id}`;
    const projected = await composition.app.request(path);
    if (!projected.ok) throw new Error(`scope view ${projected.status}: ${await projected.text()}`);
    const view: { cursor: { scope_version: number }; command_targets: Record<string, unknown[]> } = await projected.json();
    return composition.app.request(`${path}/commands`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command_key: key, payload, request_id: crypto.randomUUID(), scope_id,
        expected_scope_version: view.cursor.scope_version, targets: view.command_targets[key] ?? [] }) });
  };
  // A command races the run loop's own commits, so a stale expected version is
  // retried rather than failed: the operator intent is what the test asserts.
  const requireCommand = async (scope_id: string, key: string, payload: unknown = {}): Promise<void> => {
    await eventually(async () => {
      const response = await command(scope_id, key, payload);
      if (response.status === 202) return true;
      if (response.status === 409) return null;
      throw new Error(`${key} on ${scope_id}: ${response.status} ${await response.text()}`);
    }, `command ${key} accepted on ${scope_id}`);
  };

  const selectedExecution = (scope_id: string, worker: string) => eventually(async () => {
    const rows = await db.query<{ execution_id: string | null }>(
      "SELECT execution_id FROM authority.execution_selection WHERE scope_id=$1 AND worker_key=$2", [scope_id, worker]);
    return rows[0]?.execution_id ?? null;
  }, `selected worker ${worker} on ${scope_id}`);

  // The pinned prompt carries the execution's publication token; a real agent
  // reads it the same way, out of the prompt it was started with.
  const executionSecret = (execution_id: string) => eventually(async () => {
    const rows = await db.query<{ payload: EffectPayload }>(
      "SELECT payload FROM authority.effect_intent WHERE execution_id=$1 AND payload->>'action'='start'", [execution_id]);
    if (!rows[0]) return null;
    return unsealEffectPayload(rows[0].payload).invocation.bytes.match(/Authorization: Bearer ([A-Za-z0-9_-]+)/)?.[1] ?? null;
  }, `publication secret for execution ${execution_id}`);

  const publish = async (scope_id: string, worker: string, output_key: string, body: unknown, member = ""): Promise<string> => {
    const execution_id = await selectedExecution(scope_id, worker);
    const secret = await executionSecret(execution_id);
    const slots = await db.query<{ current_revision_id: string | null }>(
      "SELECT current_revision_id FROM authority.output_slot WHERE scope_id=$1 AND output_key=$2 AND collection_key=$3",
      [scope_id, output_key, member]);
    const response = await composition.app.request(
      `/api/runs/${run.run_id}/scopes/${scope_id}/executions/${execution_id}/outputs/${output_key}`,
      { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ request_id: crypto.randomUUID(),
          predecessor_id: slots[0]?.current_revision_id ?? null, collection_key: member, body }) });
    if (response.status !== 201) throw new Error(`publish ${output_key} on ${scope_id}: ${response.status} ${await response.text()}`);
    const receipt: { revision_id: string | null } = await response.json();
    if (!receipt.revision_id) throw new Error(`publish ${output_key} returned no revision id`);
    return receipt.revision_id;
  };

  const awaitSession = (scope_id: string, worker: string) =>
    eventually(async () => kbbl.session_for({ scope_id, worker }), `kbbl session for ${worker} on ${scope_id}`);
  const awaitTerminalExecution = async (scope_id: string): Promise<void> => {
    await eventually(async () => {
      const rows = await db.query<{ status: string }>("SELECT status FROM authority.execution WHERE scope_id=$1 ORDER BY id", [scope_id]);
      return rows.length > 0 && rows.every((row) => row.status === "terminal") ? true : null;
    }, `all executions terminal on ${scope_id}`);
  };
  const awaitState = async (scope_id: string, variant: string): Promise<void> => {
    await eventually(async () => {
      const current = await scope(scope_id);
      const data = current.local_state?.data as { variant?: string } | undefined;
      return data?.variant === variant ? true : null;
    }, `scope ${scope_id} state ${variant}`);
  };
  const awaitTerminalScope = async (scope_id: string) => {
    const subject = await scope(scope_id);
    return eventually(async () => {
      const current = await scope(scope_id);
      return current.is_terminal ? current : null;
    }, `scope ${subject.scope_key}/${subject.child_key ?? "root"} (${scope_id}) terminal`, 60_000);
  };

  return {
    composition, kbbl, run_id: run.run_id, root_scope_id: run.root_scope_id, bundle,
    pull_requests: pull_requests_state, repository_paths,
    scope, children, child, awaitChild, command, requireCommand, publish, awaitSession,
    awaitTerminalExecution, awaitState, awaitTerminalScope,
    settle(scope_id, worker, outcome = { kind: "succeeded" }) { kbbl.settle({ scope_id, worker }, outcome); },
    async close() { await composition.close(); if (!options.reuse) kbbl.stop(); },
  };
}

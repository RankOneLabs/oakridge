/**
 * The verification program's only way to a stack: it runs scripts/oakridge-shadow
 * and speaks to what that started. Nothing here creates a database, capability or
 * service; the launcher resolved them, and these are clients of that state.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { closeSync, openSync } from "node:fs";
import type { KbblHealth } from "../../kbbl/core/server/handlers/observation-health";
import { err, ok, type Result } from "../src/domain/primitives";
import { launcherStateSchema, observationStatusSchema, type LauncherState, type ObservationStatus, type ProofFailure, type SourceIdentity } from "./proof-contract";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const LAUNCHER = resolve(REPOSITORY_ROOT, "scripts/oakridge-shadow");
const REQUEST_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 30_000;
const PUBLISHER_FAILURE_LINES = 5;
/** A cold start rebuilds the WASM and the PWA and may pull PostgreSQL. */
const STACK_START_TIMEOUT_MS = 300_000;
const POLL_MS = 500;

const failure = (operation: string, entity_id: string, detail: string): Result<never, ProofFailure> =>
  err({ operation, entity_id, detail });

/** How observation looks from outside: what kbbl reports and what the launcher recorded. */
export interface ObservationFacts { readonly health: string; readonly launcher: string }
export const observationFacts = (health: KbblHealth | null, status: ObservationStatus | null): ObservationFacts => ({
  health: health?.observation.state ?? "kbbl_unavailable",
  launcher: status ? `${status.state}${status.detail ? `: ${status.detail}` : ""}` : "no status recorded" });

export interface Capabilities { readonly ingest: string; readonly read: string; readonly grade: string }
export interface TokenFacts { readonly capabilities: Capabilities; readonly private_files: boolean }

/** Everything a scenario does to the world, so the proof logic can run offline. */
export interface ProofIo {
  readonly state: LauncherState;
  startStack(): Promise<Result<void, ProofFailure>>;
  stopStack(): Promise<void>;
  /** Whether DBOS and kbbl answer now, for a scenario that attaches rather than launches. */
  stackAnswers(): Promise<boolean>;
  observationStatus(): Promise<ObservationStatus | null>;
  kbblHealth(): Promise<KbblHealth | null>;
  dbosHealthy(): Promise<boolean>;
  tokens(): Promise<Result<TokenFacts, ProofFailure>>;
  /** One value from a shadow database, read inside the shadow's container. */
  shadowQuery(database: string, query: string): Promise<Result<string, ProofFailure>>;
  killObservation(pid: number): void;
  dbos(path: string, body?: unknown): Promise<Result<unknown, ProofFailure>>;
  observationGet(path: string, capability: keyof Capabilities): Promise<Result<unknown, ProofFailure>>;
  /** The publisher's latest refusals, from a stack this proof started; an attached stack logs elsewhere. */
  publisherFailures(): Promise<readonly string[]>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export async function readLauncherState(): Promise<Result<LauncherState, ProofFailure>> {
  const child = Bun.spawn([LAUNCHER, "--print-state"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) return failure("read_launcher_state", LAUNCHER, stderr.trim());
  const parsed = launcherStateSchema.safeParse(JSON.parse(stdout));
  return parsed.success ? ok(parsed.data) : failure("read_launcher_state", LAUNCHER, "unexpected --print-state shape");
}

export function readSourceIdentity(): SourceIdentity {
  const head = Bun.spawnSync(["git", "-C", REPOSITORY_ROOT, "rev-parse", "HEAD"]);
  // A proof's own report directory is not a change to the source it proved.
  const status = Bun.spawnSync(["git", "-C", REPOSITORY_ROOT, "status", "--porcelain", "--", ".", ":(exclude)observation/verification/reports"]);
  return { git_head: head.exitCode === 0 ? head.stdout.toString().trim() : null,
    worktree_clean: status.exitCode === 0 ? status.stdout.toString().trim() === "" : null };
}

async function readJson(url: string, init: RequestInit = {}): Promise<{ readonly status: number; readonly body: unknown } | null> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch { return null; }
}

async function isPrivate(path: string): Promise<boolean> {
  return ((await stat(path)).mode & 0o077) === 0;
}

export function createShadowIo(state: LauncherState, log_path: string): ProofIo {
  let launcher: ReturnType<typeof Bun.spawn> | null = null;
  const stackAnswers = async () => (await readJson(`${state.dbos.url}/health`))?.status === 200
    && (await readJson(`${state.kbbl.url}/health`))?.status === 200;
  const tokens = async (): Promise<Result<TokenFacts, ProofFailure>> => {
    const paths = [state.observation.ingest_token_file, state.observation.read_token_file, state.observation.grade_token_file];
    try {
      const [ingest = "", read = "", grade = ""] = await Promise.all(paths.map(async (path) => (await readFile(path, "utf8")).trim()));
      return ok({ capabilities: { ingest, read, grade }, private_files: (await Promise.all(paths.map(isPrivate))).every(Boolean) });
    } catch (cause) { return failure("read_tokens", state.state_dir, cause instanceof Error ? cause.message : String(cause)); }
  };
  const authenticated = async (url: string, init: RequestInit, operation: string): Promise<Result<unknown, ProofFailure>> => {
    const response = await readJson(url, init);
    if (!response) return failure(operation, url, "no response");
    return response.status < 400 ? ok(response.body) : failure(operation, url, `HTTP ${response.status}`);
  };
  return {
    state,
    stackAnswers,
    async startStack() {
      const log = openSync(log_path, "a");
      launcher = Bun.spawn([LAUNCHER, "--observation"], { cwd: REPOSITORY_ROOT, stdin: "ignore", stdout: log, stderr: log });
      closeSync(log);
      const deadline = Date.now() + STACK_START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (launcher.exitCode !== null) return failure("start_stack", LAUNCHER, `launcher exited with status ${launcher.exitCode}; see ${log_path}`);
        if (await stackAnswers()) return ok(undefined);
        await Bun.sleep(POLL_MS);
      }
      return failure("start_stack", LAUNCHER, `DBOS and kbbl did not answer; see ${log_path}`);
    },
    async stopStack() {
      if (!launcher) return;
      launcher.kill("SIGTERM");
      await launcher.exited;
      launcher = null;
    },
    async observationStatus() {
      try {
        const parsed = observationStatusSchema.safeParse(JSON.parse(await readFile(state.observation.status_file, "utf8")));
        return parsed.success ? parsed.data : null;
      } catch { return null; }
    },
    async kbblHealth() {
      const response = await readJson(`${state.kbbl.url}/health`);
      return response?.status === 200 ? response.body as KbblHealth : null;
    },
    dbosHealthy: async () => (await readJson(`${state.dbos.url}/health`))?.status === 200,
    tokens,
    async shadowQuery(database, query) {
      const child = Bun.spawnSync(["docker", "exec", state.postgres.container, "psql", "--username", "oakridge", "--dbname", database,
        "--tuples-only", "--no-align", "--command", query], { timeout: QUERY_TIMEOUT_MS });
      return child.exitCode === 0 ? ok(child.stdout.toString().trim()) : failure("shadow_query", database, child.stderr.toString().trim() || "query did not finish");
    },
    killObservation: (pid) => { process.kill(pid, "SIGKILL"); },
    dbos: (path, body) => authenticated(`${state.dbos.url}${path}`, body === undefined ? {} : { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, "dbos_request"),
    async observationGet(path, capability) {
      const facts = await tokens();
      if (!facts.ok) return facts;
      return authenticated(`${state.observation.url}${path}`, { headers: { authorization: `Bearer ${facts.value.capabilities[capability]}` } }, "observation_request");
    },
    async publisherFailures() {
      const log = await readFile(log_path, "utf8").catch(() => "");
      return log.split("\n").filter((line) => line.includes("observation publisher:")).slice(-PUBLISHER_FAILURE_LINES);
    },
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
  };
}

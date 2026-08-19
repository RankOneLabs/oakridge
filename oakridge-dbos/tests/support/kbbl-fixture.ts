/**
 * A real kbbl, wired the way production wires it, spawning a stub instead of
 * Claude Code.
 *
 * Everything here mirrors `kbbl/core/server.ts` — the same
 * `createClaudeCodeRuntime`, the same runtime registry, the same
 * `SessionManager` construction, the same mounted routes. The single
 * substitution is `claudeBin`, which points at `stub-agent.ts`.
 *
 * That substitution is the whole design. The seam that has repeatedly broken is
 * not the model's reasoning — it is everything between oakridge deciding to run
 * a unit and an artifact coming back: the resumable-session PUT, the worktree,
 * the per-session MCP config, the channel server, the outbox tail, the JSON-RPC
 * handshake, process exit, and the terminal poll. All of that is real here.
 */
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { KbblExecutorAdapter } from "../../src/adapters/kbbl";
import type { ExecutionId, ExecutionAttemptId } from "../../src/domain/primitives";
import type { ExecutionRequest, ExecutorObservationAttempt, ExternalExecutionReference } from "../../src/domain/execution";
import type { ExecutionScenario } from "./dev-flow-harness";

import { KbblConfigSchema } from "../../../kbbl/core/config";
import { createRuntimeRegistry, type AgentRuntime } from "../../../kbbl/core/runtime";
import { createClaudeCodeRuntime } from "../../../kbbl/adapters/claude-code/index";
import { createCodexRuntime } from "../../../kbbl/adapters/codex/index";
import { SessionManager } from "../../../kbbl/core/session/session-manager";
import { mountSessionsRoutes } from "../../../kbbl/core/server/handlers/sessions";

/**
 * Absolute paths to the stubs, resolved from this module so cwd never matters.
 *
 * `fileURLToPath`, not `.pathname`: the latter stays percent-encoded, so a
 * checkout under a path with a space or a non-ASCII character would hand
 * `Bun.spawn` a name no file has. kbbl resolves its own channel-server path the
 * same way, for the same reason.
 */
export const STUB_AGENT_PATH = fileURLToPath(new URL("./stub-agent.ts", import.meta.url));
export const STUB_CODEX_PATH = fileURLToPath(new URL("./stub-codex.ts", import.meta.url));

/**
 * Which runtimes the fixture registers.
 *
 * Both are stubbed, and both are worth testing, because they share nothing:
 * claude-code delivers its prompt as a channel push to a per-session process
 * and signals completion by exiting, while codex delivers its prompt as a
 * `turn/start` call on a shared app-server and signals completion with a
 * `turn/completed` notification. A run can pick either per stage — `runtime` is
 * bound from run context — so a suite covering one proves nothing about the
 * other.
 */
export type StubbedRuntimeId = "claude-code" | "codex";

export interface KbblFixture {
  /** Base URL an oakridge `KbblExecutorAdapter` should be pointed at. */
  readonly base_url: string;
  /** Where the stub writes its diagnostics, so a failing test can say why. */
  readonly stub_log_path: string;
  /** Everything the stub logged, for assertions and failure messages. */
  readonly stub_log: () => Promise<string>;
  readonly stop: () => Promise<void>;
}

export interface KbblFixtureOptions {
  /**
   * Which runtimes to register. Defaults to claude-code alone: booting codex
   * starts a stub app-server process, which a test that never selects codex
   * should not pay for.
   */
  readonly runtimes?: readonly StubbedRuntimeId[];
  /**
   * How the stub should behave. `emit` completes the flow for either runtime.
   * `silent` accepts the prompt and never finishes. The remaining modes are
   * runtime-specific: `never_initialize` (claude-code) withholds the MCP
   * handshake so the prompt is never pushed, and `fail` (codex) reports the
   * turn as failed.
   */
  readonly stub_mode?: "emit" | "silent" | "never_initialize" | "fail";
  /** How long the stub waits for its prompt before failing loudly. */
  readonly stub_timeout_ms?: number;
  /** JSON body the stub emits to every `PUT` target the prompt names. */
  readonly stub_body?: string;
  /**
   * Reported to kbbl as the oakridge base URL. kbbl asks it whether a session
   * is held before honouring a close, so a test exercising that guard needs it
   * pointed at a real oakridge.
   */
  readonly oakridge_base_url?: string;
}

/**
 * Boots kbbl on an ephemeral port with a stub-backed runtime.
 *
 * The caller owns `stop()`. Everything lives under one temp root so a failed
 * boot cannot leave a worktree or a sessions directory behind.
 */
export const startKbblFixture = async (options: KbblFixtureOptions = {}): Promise<KbblFixture> => {
  const root = await mkdtemp(join(tmpdir(), "oakridge-kbbl-fixture-"));
  // Everything the fixture acquires is released here, including the listener:
  // `bun test` runs every file in one process, so a boot that throws after
  // `Bun.serve` would otherwise strand a port for the rest of the run.
  let started: ReturnType<typeof Bun.serve> | null = null;
  const discard = async (): Promise<void> => {
    started?.stop(true);
    await rm(root, { recursive: true, force: true });
  };

  try {
    const dataDir = join(root, "data");
    const sessionsDir = join(dataDir, "sessions");
    const worktreesDir = join(dataDir, "worktrees");
    const handoffsDir = join(dataDir, "handoffs");
    await Bun.$`mkdir -p ${dataDir} ${sessionsDir} ${worktreesDir} ${handoffsDir}`.quiet();

    const stubLogPath = join(root, "stub-agent.log");
    // The runtime bakes hook URLs from `port` at construction, before the
    // server exists. The stub fires no hooks, so the value only has to be
    // stable — but keep it honest by serving on it below.
    const server = Bun.serve({ port: 0, idleTimeout: 60, fetch: () => new Response("not ready", { status: 503 }) });
    started = server;

    // Both stubs read this file rather than the environment. kbbl owns the argv
    // it spawns with, so there is no seam to pass options through — but each
    // stub receives a path inside `dataDir` (the MCP config for claude-code,
    // the socket for codex) and reads its instructions from beside it.
    //
    // The environment is not an option here: a `process.env.X = value` assigned
    // at runtime never reaches a `Bun.spawn` child, which is how codex is
    // started. It would also be global state shared by concurrent fixtures,
    // and `bun test` runs every file in one process.
    await Bun.write(join(dataDir, "stub-config.json"), JSON.stringify({
      mode: options.stub_mode ?? "emit",
      timeout_ms: options.stub_timeout_ms ?? 20_000,
      log_path: stubLogPath,
      ...(options.stub_body !== undefined ? { body: options.stub_body } : {}),
    }, null, 2));

    const port = server.port;
    if (port === undefined) throw new Error("kbbl fixture server did not report a port");

    const selected = options.runtimes ?? ["claude-code"];
    const runtimes: AgentRuntime[] = [];
    // Deliberately not widened to `AgentRuntime`: the legacy spawn fields the
    // manager takes below belong to Claude Code, not the shared contract.
    let claudeCode: Awaited<ReturnType<typeof createClaudeCodeRuntime>> | null = null;
    let codex: AgentRuntime | null = null;
    for (const id of selected) {
      if (id === "claude-code") {
        claudeCode = await createClaudeCodeRuntime({ claudeBin: STUB_AGENT_PATH, port, dataDir });
        runtimes.push(claudeCode);
        continue;
      }
      codex = await createCodexRuntime({
        bin: STUB_CODEX_PATH,
        listenUrl: `unix://${join(dataDir, "stub-codex.sock")}`,
        sessionsDir,
      });
      runtimes.push(codex);
    }

    const registry = createRuntimeRegistry(runtimes);
    const config = KbblConfigSchema.parse({});

    const manager = new SessionManager({
      sessionsDir,
      handoffsDir,
      worktreesDir,
      // Legacy fallback, mirroring production: unused while a registry is set.
      ...(claudeCode
        ? { buildSpawnCmd: claudeCode.buildSpawnCmd, classifyEvent: claudeCode.classifyEvent, nonPersistedEventTypes: claudeCode.nonPersistedEventTypes }
        : {}),
      registry,
      config,
    });

    const app = new Hono();
    mountSessionsRoutes(app, {
      manager,
      defaultWorkdir: root,
      sessionsDir,
      registry,
      ...(options.oakridge_base_url ? { oakridgeBaseUrl: options.oakridge_base_url } : {}),
    });
    server.reload({ fetch: app.fetch });

    return {
      base_url: `http://127.0.0.1:${server.port}`,
      stub_log_path: stubLogPath,
      async stub_log() {
        const file = Bun.file(stubLogPath);
        return (await file.exists()) ? file.text() : "";
      },
      async stop() {
        // The codex app-server is a process this fixture started and nothing
        // else will reap: unlike claude-code, it outlives every session by
        // design, so without this each test leaves one running.
        const stoppable = codex as (AgentRuntime & { stopAppServer?: () => Promise<void> }) | null;
        if (stoppable?.stopAppServer) await stoppable.stopAppServer();
        await discard();
      },
    };
  } catch (error) {
    await discard();
    throw error;
  }
};

/**
 * The production adapter, driven as a harness scenario.
 *
 * `ExecutionScenario` has the same shape as `ExecutorAdapter`, so the real
 * `KbblExecutorAdapter` needs no wrapper beyond remembering each execution's
 * external reference: the harness's `deliver_input` hook drops the reference on
 * the floor, and the adapter needs it to address the session. Recording what
 * `start_or_attach` returned is enough, and keeps every HTTP call the adapter
 * makes genuinely real.
 */
export const realKbblScenario = (baseUrl: string, applicationVersion = "kbbl-fixture", options: { readonly max_silent_ms?: number } = {}): ExecutionScenario => {
  const adapter = new KbblExecutorAdapter({
    base_url: baseUrl,
    executor_function_identity: applicationVersion,
    // Short polls so a test that is waiting for a bound to trip does not spend
    // most of its time inside a single long-poll.
    observe_wait_ms: 2_000,
    ...(options.max_silent_ms !== undefined ? { max_silent_ms: options.max_silent_ms } : {}),
  });
  const references = new Map<ExecutionId, ExternalExecutionReference>();
  return {
    async start_or_attach(request: ExecutionRequest, attempt_id: string): Promise<ExternalExecutionReference> {
      const reference = await adapter.start_or_attach(request, attempt_id as ExecutionAttemptId);
      references.set(request.execution_id, reference);
      return reference;
    },
    observe_terminal(execution_id: ExecutionId, reference: ExternalExecutionReference): Promise<ExecutorObservationAttempt> {
      return adapter.observe_terminal(execution_id, reference);
    },
    cancel_or_fence(execution_id: ExecutionId, reference: ExternalExecutionReference): Promise<void> {
      return adapter.cancel_or_fence(execution_id, reference);
    },
    async deliver_input(execution_id: ExecutionId, delivery_key: string, prompt: string): Promise<void> {
      const reference = references.get(execution_id);
      if (!reference) throw new Error(`no external reference recorded for execution ${execution_id}`);
      await adapter.deliver_input(execution_id, delivery_key, prompt, reference);
    },
  };
};

/**
 * A one-stage flow whose only job is to prove the transport.
 *
 * It uses the real `spec_analyzer_v2.md` template rather than a test fixture,
 * because the template's own `PUT {{OAKRIDGE_URL}}/...` line is what the stub
 * obeys. That makes the prompt text load-bearing: if a route is renamed, or the
 * template's copy of it drifts, this fails. Today that correspondence is three
 * files independently spelling the same URL, checked by nothing.
 *
 * No `output_gate`, so the artifact releases immediately and the run reaches a
 * terminal state without an operator decision. Gate behaviour is already
 * covered by the scripted-agent tests; this one is about the wire.
 */
export const probeDefinitionGraph = (runtime: StubbedRuntimeId) => ({
  stages: {
    probe: {
      stage_type: "delegated_session",
      operator_role: "spec",
      inputs: [],
      outputs: [{ name: "spec_analysis", artifact_type: "dev.spec_analysis" }],
      config: {
        runtime,
        prompt_template_path: "dev-flow/spec_analyzer_v2.md",
        slot_bindings: {
          BRIEF_NOTES: { from: "context", path: "/brief_notes" },
          REPOSITORIES: { from: "context", path: "/repositories" },
          OAKRIDGE_URL: { from: "context", path: "/oakridge_url" },
        },
        workdir: { from: "context", path: "/repositories/0/path" },
        session_name: `probe-${runtime}-{{STAGE_INSTANCE_ID}}`,
        pre_authorized_tools: [],
        yolo: false,
      },
    },
  },
  edges: [],
});

/**
 * The probe definition's id, creating it on first use.
 *
 * Definitions are immutable per `(name, version)` and the e2e database outlives
 * a single run, so the second run of this suite gets a 409 rather than a fresh
 * row. That refusal is the storage layer working correctly — identical content
 * under an existing identity is the same definition — so the right response is
 * to adopt the stored one, not to mint a new name per run. Names stay stable,
 * which also keeps a person reading the database able to tell what made a row.
 */
export const createProbeDefinition = async (oakridgeUrl: string, runtime: StubbedRuntimeId, name: string): Promise<string> => {
  const response = await fetch(`${oakridgeUrl}/workflow_defs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, version: 1, graph: probeDefinitionGraph(runtime) }),
  });
  const text = await response.text();
  if (response.ok) return (JSON.parse(text) as { id: string }).id;
  if (response.status !== 409) throw new Error(`probe definition creation failed: ${response.status} ${text}`);

  const listed = await fetch(`${oakridgeUrl}/workflow_defs`);
  if (!listed.ok) throw new Error(`probe definition lookup failed: ${listed.status} ${await listed.text()}`);
  const existing = (await listed.json() as ReadonlyArray<{ id: string; name: string; version: number }>)
    .find((candidate) => candidate.name === name && candidate.version === 1);
  if (!existing) throw new Error(`probe definition '${name}@1' was refused as a conflict but is not listed`);
  return existing.id;
};

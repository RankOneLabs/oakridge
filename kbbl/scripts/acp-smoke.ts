/**
 * ACP compatibility smoke harness — cohort 0 of the ACP migration
 * (comms/oakridge-kbbl-acp-migration-spec.md §23, PR 1).
 *
 * Spawns a real ACP agent as a child process and exercises the protocol
 * surface kbbl will depend on: initialize, session/new, config discovery,
 * prompt streaming, a second prompt, cancel, child kill, and a fresh child
 * + session/load. Prints a capability/behavior report as markdown.
 *
 * This script never touches production kbbl paths. It exists to prove or
 * disprove candidate agents before any adapter is deleted.
 *
 * Usage:
 *   bun scripts/acp-smoke.ts --agent "<command> [args...]" --cwd <dir> \
 *     [--prompt "<text>"] [--skip-load] [--permission-mode auto-first|cancel] \
 *     [--timeout-ms 120000]
 *
 * Examples:
 *   bun scripts/acp-smoke.ts --agent "bunx codex-acp" --cwd /tmp/acp-scratch
 *   bun scripts/acp-smoke.ts --agent "node_modules/.bin/claude-code-cli-acp" --cwd /tmp/acp-scratch
 */

import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ActiveSession,
  type Stream,
} from "@agentclientprotocol/sdk";
import type * as schema from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import { existsSync, readdirSync, readFileSync } from "node:fs";

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

interface SmokeError {
  readonly step: string;
  readonly detail: string;
}

interface SmokeArgs {
  readonly agent_command: string;
  readonly agent_args: readonly string[];
  readonly cwd: string;
  readonly prompt_text: string;
  readonly skip_load: boolean;
  readonly permission_mode: "auto-first" | "cancel";
  readonly timeout_ms: number;
}

interface StepOutcome {
  readonly name: string;
  readonly status: "pass" | "fail" | "skipped";
  readonly detail: string;
}

interface ChildProcessSnapshot {
  readonly pid: number;
  readonly command_line: string;
}

/** Everything the report needs, accumulated as the run progresses. */
interface SmokeReport {
  agent_command: string;
  protocol_version: number | null;
  agent_info: string | null;
  capabilities: schema.AgentCapabilities | null;
  auth_methods: readonly string[];
  config_options: readonly schema.SessionConfigOption[];
  modes: readonly string[];
  session_id: string | null;
  steps: StepOutcome[];
  /** Descendant process command lines observed during an active prompt. */
  descendants_during_prompt: ChildProcessSnapshot[];
  update_kinds_seen: Set<string>;
}

/** Splits a command spec on whitespace, keeping double-quoted segments intact. */
function split_command_spec(spec: string): string[] {
  const parts: string[] = [];
  let current = "";
  let in_quotes = false;
  for (const char of spec) {
    if (char === '"') in_quotes = !in_quotes;
    else if (!in_quotes && /\s/.test(char)) {
      if (current.length > 0) parts.push(current);
      current = "";
    } else current += char;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function parse_args(argv: readonly string[]): Result<SmokeArgs, SmokeError> {
  let agent_spec: string | null = null;
  let cwd: string | null = null;
  let prompt_text =
    "Reply with exactly the word ACK and nothing else. Do not use any tools.";
  let skip_load = false;
  let permission_mode: SmokeArgs["permission_mode"] = "auto-first";
  let timeout_ms = 120_000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") agent_spec = argv[++i] ?? null;
    else if (arg === "--cwd") cwd = argv[++i] ?? null;
    else if (arg === "--prompt") prompt_text = argv[++i] ?? prompt_text;
    else if (arg === "--skip-load") skip_load = true;
    else if (arg === "--permission-mode")
      permission_mode = (argv[++i] as SmokeArgs["permission_mode"]) ?? "auto-first";
    else if (arg === "--timeout-ms") timeout_ms = Number(argv[++i] ?? timeout_ms);
    else
      return {
        ok: false,
        error: { step: "parse_args", detail: `unknown argument: ${arg}` },
      };
  }

  if (agent_spec === null || cwd === null) {
    return {
      ok: false,
      error: {
        step: "parse_args",
        detail: "--agent \"<command> [args...]\" and --cwd <dir> are required",
      },
    };
  }

  const [agent_command, ...agent_args] = split_command_spec(agent_spec);
  if (agent_command === undefined) {
    return {
      ok: false,
      error: { step: "parse_args", detail: "--agent must name a command" },
    };
  }

  return {
    ok: true,
    value: {
      agent_command,
      agent_args,
      cwd,
      prompt_text,
      skip_load,
      permission_mode,
      timeout_ms,
    },
  };
}

/** Reads /proc to snapshot every descendant of `root_pid` with its cmdline. */
function snapshot_descendants(root_pid: number): ChildProcessSnapshot[] {
  // /proc is Linux-only; elsewhere skip evidence capture rather than throw
  // inside the snapshot timer and sink the whole run.
  if (!existsSync("/proc")) return [];
  const parent_of = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const after_comm = stat.slice(stat.lastIndexOf(")") + 2);
      const ppid = Number(after_comm.split(" ")[1]);
      parent_of.set(pid, ppid);
    } catch {
      // process exited between readdir and read — ignore
    }
  }
  const descendants: ChildProcessSnapshot[] = [];
  const is_descendant = (pid: number): boolean => {
    let current = pid;
    for (let depth = 0; depth < 32; depth++) {
      const ppid = parent_of.get(current);
      if (ppid === undefined || ppid === 0) return false;
      if (ppid === root_pid) return true;
      current = ppid;
    }
    return false;
  };
  for (const pid of parent_of.keys()) {
    if (!is_descendant(pid)) continue;
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .replaceAll("\0", " ")
        .trim();
      if (cmdline.length > 0) descendants.push({ pid, command_line: cmdline });
    } catch {
      // exited — ignore
    }
  }
  return descendants;
}

type AgentChild = ChildProcessByStdio<Writable, Readable, Readable>;

interface SpawnedAgent {
  readonly child: AgentChild;
  readonly stream: Stream;
  readonly stderr_lines: string[];
  readonly exited: Promise<number | null>;
}

function spawn_agent(args: SmokeArgs): Result<SpawnedAgent, SmokeError> {
  let child: AgentChild;
  try {
    child = spawn(args.agent_command, [...args.agent_args], {
      cwd: args.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
  } catch (error) {
    return {
      ok: false,
      error: { step: "spawn", detail: String(error) },
    };
  }

  const stderr_lines: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim().length > 0) stderr_lines.push(line);
      if (stderr_lines.length > 500) stderr_lines.shift();
    }
  });

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  const stream = ndJsonStream(
    NodeWritable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    NodeReadable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );

  return { ok: true, value: { child, stream, stderr_lines, exited } };
}

function record(report: SmokeReport, outcome: StepOutcome): void {
  report.steps.push(outcome);
  const marker =
    outcome.status === "pass" ? "PASS" : outcome.status === "fail" ? "FAIL" : "SKIP";
  console.error(`[smoke] ${marker} ${outcome.name}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
}

function with_timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms: ${label}`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Drains updates for one prompt turn; returns the stop reason. */
async function drain_turn(
  session: ActiveSession,
  report: SmokeReport,
  timeout_ms: number,
): Promise<schema.StopReason> {
  for (;;) {
    const message = await with_timeout(session.nextUpdate(), timeout_ms, "nextUpdate");
    if (message.kind === "stop") return message.stopReason;
    const update = message.update as { sessionUpdate?: string };
    if (typeof update.sessionUpdate === "string") {
      report.update_kinds_seen.add(update.sessionUpdate);
    }
  }
}

function render_report(report: SmokeReport): string {
  const capability_rows: string[] = [];
  const caps = report.capabilities;
  const session_caps = caps?.sessionCapabilities;
  capability_rows.push(
    `| loadSession | ${caps?.loadSession === true} |`,
    `| session/resume | ${session_caps?.resume != null} |`,
    `| session/close | ${session_caps?.close != null} |`,
    `| session/list | ${session_caps?.list != null} |`,
    `| session/fork | ${session_caps?.fork != null} |`,
    `| promptCapabilities.image | ${caps?.promptCapabilities?.image === true} |`,
    `| promptCapabilities.embeddedContext | ${caps?.promptCapabilities?.embeddedContext === true} |`,
    `| mcpCapabilities | ${JSON.stringify(caps?.mcpCapabilities ?? null)} |`,
  );

  const escape_cell = (text: string): string => text.replaceAll("|", "\\|");

  const config_rows = report.config_options.map(
    (option) =>
      `| ${escape_cell(option.id)} | ${escape_cell(option.category ?? "-")} | ${option.type} | ${escape_cell(option.name)} |`,
  );

  const step_rows = report.steps.map(
    (step) => `| ${step.name} | ${step.status} | ${escape_cell(step.detail)} |`,
  );

  const descendant_lines =
    report.descendants_during_prompt.length === 0
      ? ["(none observed)"]
      : report.descendants_during_prompt.map(
          (snapshot) => `- pid ${snapshot.pid}: \`${snapshot.command_line}\``,
        );

  return [
    `## ACP smoke report`,
    ``,
    `- agent: \`${report.agent_command}\``,
    `- protocol version: ${report.protocol_version}`,
    `- agent info: ${report.agent_info ?? "(none)"}`,
    `- auth methods: ${report.auth_methods.join(", ") || "(none)"}`,
    `- session id: \`${report.session_id ?? "(none)"}\``,
    `- modes: ${report.modes.join(", ") || "(none)"}`,
    `- update kinds seen: ${[...report.update_kinds_seen].sort().join(", ") || "(none)"}`,
    ``,
    `### Capabilities`,
    ``,
    `| capability | value |`,
    `|---|---|`,
    ...capability_rows,
    ``,
    `### Config options`,
    ``,
    ...(config_rows.length > 0
      ? [`| id | category | type | name |`, `|---|---|---|---|`, ...config_rows]
      : [`(none advertised)`]),
    ``,
    `### Descendant processes during prompt (billing evidence)`,
    ``,
    ...descendant_lines,
    ``,
    `### Steps`,
    ``,
    `| step | status | detail |`,
    `|---|---|---|`,
    ...step_rows,
    ``,
  ].join("\n");
}

async function run(args: SmokeArgs): Promise<SmokeReport> {
  const report: SmokeReport = {
    agent_command: [args.agent_command, ...args.agent_args].join(" "),
    protocol_version: null,
    agent_info: null,
    capabilities: null,
    auth_methods: [],
    config_options: [],
    modes: [],
    session_id: null,
    steps: [],
    descendants_during_prompt: [],
    update_kinds_seen: new Set(),
  };

  const spawned = spawn_agent(args);
  if (!spawned.ok) {
    record(report, { name: "spawn", status: "fail", detail: spawned.error.detail });
    return report;
  }
  record(report, {
    name: "spawn",
    status: "pass",
    detail: `pid ${spawned.value.child.pid}`,
  });

  const app = client({ name: "kbbl-acp-smoke" });

  app.onRequest("session/request_permission", (context) => {
    const options = context.params.options;
    const chosen = options[0];
    record(report, {
      name: "permission_request",
      status: "pass",
      detail: `options: ${options.map((o) => `${o.optionId}(${o.kind})`).join(", ")}`,
    });
    if (args.permission_mode === "cancel" || chosen === undefined) {
      return { outcome: { outcome: "cancelled" as const } };
    }
    return {
      outcome: { outcome: "selected" as const, optionId: chosen.optionId },
    };
  });

  // fs/terminal capabilities are deliberately not advertised; a request for
  // them anyway is a compatibility signal worth recording.
  app.onRequest("fs/read_text_file", () => {
    record(report, {
      name: "unexpected_fs_read",
      status: "fail",
      detail: "agent called fs/read_text_file despite capability not advertised",
    });
    throw RequestError.methodNotFound("fs/read_text_file");
  });

  try {
    await app.connectWith(spawned.value.stream, async (ctx) => {
      // -- initialize ------------------------------------------------------
      const init = await with_timeout(
        ctx.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "kbbl-acp-smoke", version: "0.0.1" },
        }),
        args.timeout_ms,
        "initialize",
      );
      report.protocol_version = init.protocolVersion;
      report.capabilities = init.agentCapabilities ?? null;
      report.agent_info = init.agentInfo
        ? `${init.agentInfo.name} ${init.agentInfo.version ?? ""}`.trim()
        : null;
      report.auth_methods = (init.authMethods ?? []).map((m) => m.id);
      record(report, {
        name: "initialize",
        status: init.protocolVersion === PROTOCOL_VERSION ? "pass" : "fail",
        detail: `protocolVersion=${init.protocolVersion}`,
      });

      // -- session/new -----------------------------------------------------
      const session = await with_timeout(
        ctx.buildSession(args.cwd).start(),
        args.timeout_ms,
        "session/new",
      );
      report.session_id = session.sessionId;
      report.config_options = session.newSessionResponse.configOptions ?? [];
      report.modes = (session.modes?.availableModes ?? []).map(
        (mode) => `${mode.id}${mode.id === session.modes?.currentModeId ? "*" : ""}`,
      );
      record(report, {
        name: "session/new",
        status: "pass",
        detail: `sessionId=${session.sessionId}`,
      });
      record(report, {
        name: "config_discovery",
        status: report.config_options.length > 0 ? "pass" : "fail",
        detail:
          report.config_options
            .map((option) => `${option.id}[${option.category ?? "?"}]`)
            .join(", ") || "no configOptions in session/new response",
      });

      // -- first prompt (with descendant snapshot mid-turn) ---------------
      const root_pid = spawned.value.child.pid;
      const snapshot_timer = setTimeout(() => {
        if (root_pid !== undefined) {
          report.descendants_during_prompt = snapshot_descendants(root_pid);
        }
      }, 3_000);
      const first = session.prompt(args.prompt_text);
      const first_stop = await drain_turn(session, report, args.timeout_ms);
      await first;
      clearTimeout(snapshot_timer);
      record(report, {
        name: "first_prompt",
        status: first_stop === "end_turn" ? "pass" : "fail",
        detail: `stopReason=${first_stop}`,
      });

      // -- second prompt (session continuity) ------------------------------
      const second = session.prompt(
        "Reply with exactly the word ACK2 and nothing else.",
      );
      const second_stop = await drain_turn(session, report, args.timeout_ms);
      await second;
      record(report, {
        name: "second_prompt",
        status: second_stop === "end_turn" ? "pass" : "fail",
        detail: `stopReason=${second_stop}`,
      });

      // -- cancel ----------------------------------------------------------
      const cancelled = session.prompt(
        "Count from 1 to 100000 slowly, one number per line.",
      );
      setTimeout(() => {
        void ctx.notify("session/cancel", { sessionId: session.sessionId });
      }, 1_500);
      const cancel_stop = await drain_turn(session, report, args.timeout_ms);
      await cancelled.catch(() => undefined);
      record(report, {
        name: "cancel",
        status: cancel_stop === "cancelled" ? "pass" : "fail",
        detail: `stopReason=${cancel_stop}`,
      });

      session.dispose();
    });
  } catch (error) {
    record(report, {
      name: "connection",
      status: "fail",
      detail: String(error),
    });
  }

  // -- kill child, respawn, session/load ----------------------------------
  spawned.value.child.kill("SIGTERM");
  const exit_code = await with_timeout(
    spawned.value.exited,
    10_000,
    "child exit after SIGTERM",
  ).catch(() => {
    spawned.value.child.kill("SIGKILL");
    return null;
  });
  record(report, {
    name: "child_terminate",
    status: "pass",
    detail: `exit=${exit_code}`,
  });

  const load_supported = report.capabilities?.loadSession === true;
  if (args.skip_load || !load_supported || report.session_id === null) {
    record(report, {
      name: "session/load_after_restart",
      status: "skipped",
      detail: args.skip_load
        ? "--skip-load"
        : load_supported
          ? "no session id"
          : "agent does not advertise loadSession",
    });
    return report;
  }

  const respawned = spawn_agent(args);
  if (!respawned.ok) {
    record(report, {
      name: "session/load_after_restart",
      status: "fail",
      detail: `respawn failed: ${respawned.error.detail}`,
    });
    return report;
  }

  const load_app = client({ name: "kbbl-acp-smoke-load" });
  load_app.onRequest("session/request_permission", () => ({
    outcome: { outcome: "cancelled" as const },
  }));
  let replayed_updates = 0;
  load_app.onNotification("session/update", () => {
    replayed_updates += 1;
  });

  try {
    await load_app.connectWith(respawned.value.stream, async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "kbbl-acp-smoke", version: "0.0.1" },
      });
      await with_timeout(
        ctx.request("session/load", {
          sessionId: report.session_id as schema.SessionId,
          cwd: args.cwd,
          mcpServers: [],
        }),
        args.timeout_ms,
        "session/load",
      );
      record(report, {
        name: "session/load_after_restart",
        status: "pass",
        detail: `replayed ${replayed_updates} session/update notifications`,
      });
    });
  } catch (error) {
    record(report, {
      name: "session/load_after_restart",
      status: "fail",
      detail: String(error),
    });
  } finally {
    respawned.value.child.kill("SIGKILL");
  }

  return report;
}

const parsed = parse_args(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`acp-smoke: ${parsed.error.detail}`);
  process.exit(2);
}

const final_report = await run(parsed.value);
console.log(render_report(final_report));
const failed = final_report.steps.some((step) => step.status === "fail");
process.exit(failed ? 1 : 0);

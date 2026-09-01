// OS process lifecycle for ACP agent children (§8.2). Owns spawning,
// stderr capture, and bounded termination — nothing protocol- or
// provider-specific. The stderr stream is drained into a bounded ring so
// agent noise can never backpressure or interleave with the ACP stdout
// protocol stream.

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { buildAgentEnv, type AgentProfile } from "./agent-profile";
import { acpError, err, ok, type AcpError, type Result } from "./types";

const STDERR_MAX_LINES = 500;

export interface AcpChildProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  /** Bounded snapshot of recent stderr lines for diagnostics. */
  stderrTail(): readonly string[];
  readonly exited: Promise<number>;
  terminate(signal?: "SIGTERM" | "SIGKILL"): void;
  /** SIGTERM, then SIGKILL after the configured deadline. Resolves on exit. */
  kill(): Promise<number>;
  /** Registers the single exit listener (delivered exactly once). */
  onExit(listener: (code: number) => void): void;
}

export interface SupervisorTimeouts {
  readonly graceful_kill_ms: number;
  readonly hard_kill_ms: number;
}

export class AcpProcessSupervisor {
  constructor(private readonly timeouts: SupervisorTimeouts) {}

  spawn(
    profile: AgentProfile,
    cwd: string,
  ): Result<AcpChildProcess, AcpError> {
    let child: ReturnType<typeof spawn>;
    try {
      // Array-form argv, no shell: profile args are never re-tokenized.
      child = spawn(profile.command, [...profile.args], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildAgentEnv(profile.env_policy, process.env),
      });
    } catch (error) {
      return err(
        acpError("agent_spawn_failed", "supervisor.spawn", String(error)),
      );
    }
    if (child.pid === undefined || !child.stdin || !child.stdout || !child.stderr) {
      // The spawn error (e.g. ENOENT) arrives as an async 'error' event;
      // without a listener it would crash the kbbl process.
      child.once("error", () => {});
      child.kill("SIGKILL");
      return err(
        acpError(
          "agent_spawn_failed",
          "supervisor.spawn",
          `spawn of "${profile.command}" produced no pid/stdio`,
        ),
      );
    }

    const stderrLines: string[] = [];
    let stderrBuffered = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffered += chunk.toString("utf8");
      let nl: number;
      while ((nl = stderrBuffered.indexOf("\n")) >= 0) {
        const line = stderrBuffered.slice(0, nl);
        stderrBuffered = stderrBuffered.slice(nl + 1);
        if (line.trim().length === 0) continue;
        stderrLines.push(line);
        if (stderrLines.length > STDERR_MAX_LINES) stderrLines.shift();
      }
    });

    const exitListeners: Array<(code: number) => void> = [];
    let exitCode: number | null = null;
    const exited = new Promise<number>((resolve) => {
      child.once("exit", (code, signal) => {
        exitCode = code ?? (signal ? 128 : 1);
        resolve(exitCode);
        for (const listener of exitListeners.splice(0)) listener(exitCode);
      });
    });
    // A spawn-time error (ENOENT etc.) arrives as an 'error' event, not
    // 'exit'; without this handler it would crash the kbbl process.
    child.once("error", () => {
      if (exitCode === null) child.emit("exit", 127, null);
    });

    const timeouts = this.timeouts;
    const pid = child.pid;
    const handle: AcpChildProcess = {
      pid,
      stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(
        child.stdout,
      ) as unknown as ReadableStream<Uint8Array>,
      stderrTail: () => [...stderrLines],
      exited,
      terminate(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
        if (exitCode === null) child.kill(signal);
      },
      async kill(): Promise<number> {
        if (exitCode !== null) return exitCode;
        child.kill("SIGTERM");
        const graceful = await Promise.race([
          exited,
          delay(timeouts.graceful_kill_ms).then(() => null),
        ]);
        if (graceful !== null) return graceful;
        child.kill("SIGKILL");
        const forced = await Promise.race([
          exited,
          delay(timeouts.hard_kill_ms).then(() => null),
        ]);
        // A process that survives SIGKILL is unreapable from here; report
        // the bounded deadline rather than waiting forever (guardrail 19).
        return forced ?? 137;
      },
      onExit(listener: (code: number) => void): void {
        if (exitCode !== null) {
          listener(exitCode);
          return;
        }
        exitListeners.push(listener);
      },
    };
    return ok(handle);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

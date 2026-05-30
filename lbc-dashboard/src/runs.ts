/**
 * In-memory run registry + subprocess launcher seam.
 *
 * The registry tracks each Python run's lifecycle (running → exited/failed),
 * computes the cell_id the PWA navigates to, and exposes a cancel handle.
 *
 * Registry is in-memory; a dashboard restart forgets in-flight runs (their
 * cells still surface via disk discovery; only the live process-status signal
 * is lost).
 */
import { dirname } from "node:path";

import type { CellId } from "../pwa/lib/ids";
import { conditionName, type RunSpec, type RunSummary } from "./contracts";
import { cellIdFor, resolveRunRoot } from "./store";

// ---------------------------------------------------------------------------
// Launcher seam
// ---------------------------------------------------------------------------

export interface Launcher {
  spawn(
    args: string[],
    opts: { cwd: string; env: Record<string, string | undefined> },
  ): {
    pid: number;
    kill: () => void;
    done: Promise<{ code: number; stderrTail: string }>;
  };
}

const STDERR_TAIL_LIMIT = 8 * 1024;

export const defaultLauncher: Launcher = {
  spawn(args, { cwd, env }) {
    const filteredEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) filteredEnv[k] = v;
    }
    const proc = Bun.spawn(args, {
      cwd,
      env: filteredEnv,
      stderr: "pipe",
    });

    const chunks: string[] = [];
    let size = 0;
    const decoder = new TextDecoder();

    const stderrDone = (async () => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          chunks.push(text);
          size += text.length;
          while (size > STDERR_TAIL_LIMIT && chunks.length > 0) {
            size -= chunks.shift()!.length;
          }
        }
      } catch {
        // ignore stderr read errors
      } finally {
        const flush = decoder.decode();
        if (flush) {
          chunks.push(flush);
          size += flush.length;
          while (size > STDERR_TAIL_LIMIT && chunks.length > 0) {
            size -= chunks.shift()!.length;
          }
        }
        reader.releaseLock();
      }
    })();

    const done = (async () => {
      const code = await proc.exited;
      await stderrDone;
      const full = chunks.join("");
      return {
        code,
        stderrTail:
          full.length > STDERR_TAIL_LIMIT ? full.slice(-STDERR_TAIL_LIMIT) : full,
      };
    })();

    return { pid: proc.pid, kill: () => proc.kill(), done };
  },
};

// ---------------------------------------------------------------------------
// Run timestamp helpers
// ---------------------------------------------------------------------------

/**
 * Produce a run timestamp in Python's strftime('%Y-%m-%dT%H-%M-%S-%fZ') shape.
 * JS Date only has millisecond precision, so the microsecond field is the
 * milliseconds zero-padded to 6 digits (last three are always '000').
 */
export function formatRunTs(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  const seconds = String(d.getUTCSeconds()).padStart(2, "0");
  const micros = `${String(d.getUTCMilliseconds()).padStart(3, "0")}000`;
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}-${micros}Z`;
}

export function newRunTs(): string {
  return formatRunTs(new Date());
}

// ---------------------------------------------------------------------------
// RunRecord
// ---------------------------------------------------------------------------

export interface RunRecord {
  runId: string;
  run_ts: string;
  spec: RunSpec;
  cell_id: CellId;
  status: "running" | "exited" | "failed";
  pid: number;
  started_ms: number;
  exit_code: number | null;
  stderr_tail: string;
}

// ---------------------------------------------------------------------------
// RunRegistry
// ---------------------------------------------------------------------------

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  private readonly handles = new Map<string, { kill: () => void }>();

  constructor(private readonly launcher: Launcher = defaultLauncher) {}

  launch({
    runTs,
    spec,
    specPath,
    outputDir,
  }: {
    runTs: string;
    spec: RunSpec;
    specPath: string;
    outputDir: string;
  }): RunRecord {
    const cell_id = cellIdFor(
      runTs,
      spec.target,
      conditionName(spec.condition.kind, spec.condition.n),
    );

    const cwd = dirname(resolveRunRoot());
    const env = { ...process.env };

    const handle = this.launcher.spawn(
      [
        "uv",
        "run",
        "python",
        "-m",
        "legit_biz_club.run",
        "--spec",
        specPath,
        "--output-dir",
        outputDir,
      ],
      { cwd, env },
    );

    const record: RunRecord = {
      runId: runTs,
      run_ts: runTs,
      spec,
      cell_id,
      status: "running",
      pid: handle.pid,
      started_ms: Date.now(),
      exit_code: null,
      stderr_tail: "",
    };

    this.runs.set(runTs, record);
    this.handles.set(runTs, handle);

    void handle.done.then(({ code, stderrTail }) => {
      const current = this.runs.get(runTs);
      if (current && current.status === "running") {
        current.status = code === 0 ? "exited" : "failed";
        current.exit_code = code;
        current.stderr_tail = stderrTail;
      }
      this.handles.delete(runTs);
    });

    return record;
  }

  list(): RunSummary[] {
    return [...this.runs.values()]
      .sort((a, b) => b.started_ms - a.started_ms)
      .map((r) => this.toSummary(r));
  }

  cancel(runId: string): boolean {
    const record = this.runs.get(runId);
    if (!record) return false;
    const handle = this.handles.get(runId);
    if (handle) {
      handle.kill();
      this.handles.delete(runId);
    }
    if (record.status === "running") {
      record.status = "failed";
    }
    return true;
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  toSummary(record: RunRecord): RunSummary {
    return {
      runId: record.runId,
      run_ts: record.run_ts,
      cell_id: record.cell_id,
      target: record.spec.target,
      condition: record.spec.condition,
      status: record.status,
      started_ms: record.started_ms,
      exit_code: record.exit_code,
      stderr_tail: record.stderr_tail,
    };
  }
}

export const runRegistry = new RunRegistry();

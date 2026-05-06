/**
 * Cell discovery + event tailing.
 *
 * Reads from legit-biz-club's per-cell sidecars on disk:
 *   <run_root>/<run_ts>/<target_name>/<condition_name>/
 *     ├── <artifact_filename>     final artifact
 *     ├── events.jsonl            workspace event log (one JSON record/line)
 *     ├── commits/v0001.<ext> ... per-commit snapshots
 *     └── agent_memory/           per-agent SqliteStores (we ignore)
 *
 * Cell IDs are stable derivations of the on-disk path so they survive
 * across dashboard restarts and can be used as URL fragments. The
 * Python harness writes everything; the dashboard is purely a reader.
 */
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface CellEvent {
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface CellSummary {
  cell_id: string;
  run_ts: string;
  target_name: string;
  condition_name: string;
  cell_dir: string;
  status: "active" | "ended";
  // Coarse last-activity hint for sorting; comes from events.jsonl mtime.
  last_activity_ms: number;
  event_count: number;
}

export interface CellDetail extends CellSummary {
  events: CellEvent[];
  artifact_filename: string | null;
  commit_count: number;
}

/**
 * Resolve the run-root directory. Defaults to the sibling
 * legit-biz-club/.run/ — the standard layout when both packages live
 * under oakridge/. Override with LBC_RUN_ROOT for unusual setups.
 */
export function resolveRunRoot(): string {
  const fromEnv = process.env.LBC_RUN_ROOT;
  if (fromEnv) return resolve(fromEnv);
  // server.ts runs from lbc-dashboard/, so the sibling path is ../legit-biz-club/.run.
  return resolve(import.meta.dirname, "..", "..", "legit-biz-club", ".run");
}

const RUN_ROOT = resolveRunRoot();

/**
 * Build the cell_id from the path segments. Stable + URL-safe; the
 * combination of run-timestamp + target + condition uniquely
 * identifies a cell in the v1 layout.
 */
function cellIdFor(runTs: string, target: string, condition: string): string {
  return `${runTs}__${target}__${condition}`;
}

function parseCellId(
  cellId: string,
): { runTs: string; target: string; condition: string } | null {
  const parts = cellId.split("__");
  if (parts.length !== 3) return null;
  return { runTs: parts[0]!, target: parts[1]!, condition: parts[2]! };
}

/**
 * Walk the run-root and enumerate every cell directory. A cell is
 * any 3-deep dir under the run-root that contains an events.jsonl;
 * the absence of events.jsonl just means the cell hasn't started.
 */
export async function listCells(): Promise<CellSummary[]> {
  await mkdir(RUN_ROOT, { recursive: true });
  const summaries: CellSummary[] = [];
  const runDirs = await safeReaddir(RUN_ROOT);
  for (const runTs of runDirs) {
    const runDir = join(RUN_ROOT, runTs);
    const targetDirs = await safeReaddir(runDir);
    for (const target of targetDirs) {
      const targetDir = join(runDir, target);
      const conditionDirs = await safeReaddir(targetDir);
      for (const condition of conditionDirs) {
        const cellDir = join(targetDir, condition);
        const summary = await summarize(runTs, target, condition, cellDir);
        if (summary) summaries.push(summary);
      }
    }
  }
  // Newest first by last activity, then by run timestamp as a tiebreaker.
  summaries.sort((a, b) => {
    if (a.last_activity_ms !== b.last_activity_ms) {
      return b.last_activity_ms - a.last_activity_ms;
    }
    return b.run_ts.localeCompare(a.run_ts);
  });
  return summaries;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function summarize(
  runTs: string,
  target: string,
  condition: string,
  cellDir: string,
): Promise<CellSummary | null> {
  const eventsPath = join(cellDir, "events.jsonl");
  let mtimeMs = 0;
  let eventCount = 0;
  let status: CellSummary["status"] = "active";
  try {
    const st = await stat(eventsPath);
    mtimeMs = st.mtimeMs;
    const contents = await readFile(eventsPath, "utf-8");
    const lines = contents.split("\n").filter((l) => l.trim());
    eventCount = lines.length;
    // Heuristic: a cell is "ended" if its log contains a terminal
    // event (incremental_terminated alone for INCREMENTAL_ONLY, or
    // proposal_picked / proposal_applied at the tail for protocols
    // that include consensus). Cheap-and-cheerful: any line whose
    // kind contains "terminated" or "picked" near the tail flags
    // ended. The harness doesn't currently emit a unified
    // "cell_ended" event; if it ever does, prefer that.
    const tail = lines.slice(-3).join("\n");
    if (
      tail.includes("incremental_terminated") ||
      tail.includes("proposal_picked")
    ) {
      status = "ended";
    }
  } catch {
    // No events.jsonl yet — cell directory exists but the run hasn't
    // emitted its first event. Treat as active with zero events.
    try {
      const st = await stat(cellDir);
      mtimeMs = st.mtimeMs;
    } catch {
      return null;
    }
  }
  return {
    cell_id: cellIdFor(runTs, target, condition),
    run_ts: runTs,
    target_name: target,
    condition_name: condition,
    cell_dir: relative(RUN_ROOT, cellDir),
    status,
    last_activity_ms: mtimeMs,
    event_count: eventCount,
  };
}

/**
 * Read full detail for one cell — events + artifact filename +
 * commit count. The artifact's content is fetched separately so
 * a large artifact doesn't bloat list responses.
 */
export async function getCellDetail(cellId: string): Promise<CellDetail | null> {
  const parts = parseCellId(cellId);
  if (parts === null) return null;
  const cellDir = join(RUN_ROOT, parts.runTs, parts.target, parts.condition);
  const summary = await summarize(parts.runTs, parts.target, parts.condition, cellDir);
  if (summary === null) return null;
  const events = await readEvents(cellDir);
  const artifactFilename = await detectArtifactFilename(cellDir);
  const commitCount = await countCommits(cellDir);
  return {
    ...summary,
    events,
    artifact_filename: artifactFilename,
    commit_count: commitCount,
  };
}

export async function readEvents(cellDir: string): Promise<CellEvent[]> {
  try {
    const contents = await readFile(join(cellDir, "events.jsonl"), "utf-8");
    const events: CellEvent[] = [];
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as CellEvent);
      } catch {
        // Skip malformed lines — don't break the whole stream.
      }
    }
    return events;
  } catch {
    return [];
  }
}

async function detectArtifactFilename(cellDir: string): Promise<string | null> {
  // The artifact lives at <cell_dir>/<artifact_filename>. We don't
  // know the filename a priori (target-dependent), so scan the dir
  // for the file that isn't a known sidecar.
  const known = new Set(["events.jsonl", "commits", "agent_memory"]);
  try {
    const entries = await readdir(cellDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && !known.has(e.name)) {
        return e.name;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function countCommits(cellDir: string): Promise<number> {
  try {
    const entries = await readdir(join(cellDir, "commits"));
    return entries.filter((n) => /^v\d+\./.test(n)).length;
  } catch {
    return 0;
  }
}

export async function readArtifact(cellId: string): Promise<string | null> {
  const parts = parseCellId(cellId);
  if (parts === null) return null;
  const cellDir = join(RUN_ROOT, parts.runTs, parts.target, parts.condition);
  const filename = await detectArtifactFilename(cellDir);
  if (filename === null) return null;
  try {
    return await readFile(join(cellDir, filename), "utf-8");
  } catch {
    return null;
  }
}

export interface CommitSnapshot {
  index: number;
  filename: string;
  content: string;
}

export async function readCommits(cellId: string): Promise<CommitSnapshot[]> {
  const parts = parseCellId(cellId);
  if (parts === null) return [];
  const cellDir = join(RUN_ROOT, parts.runTs, parts.target, parts.condition);
  const commitsDir = join(cellDir, "commits");
  let entries: string[];
  try {
    entries = await readdir(commitsDir);
  } catch {
    return [];
  }
  const snapshots: CommitSnapshot[] = [];
  for (const filename of entries) {
    const m = filename.match(/^v(\d+)\./);
    if (m === null) continue;
    const index = Number(m[1]);
    try {
      const content = await readFile(join(commitsDir, filename), "utf-8");
      snapshots.push({ index, filename, content });
    } catch {
      // Skip unreadable files — don't fail the whole list.
    }
  }
  snapshots.sort((a, b) => a.index - b.index);
  return snapshots;
}

/**
 * Resolve a cell_id to its on-disk path. Used for the SSE handler
 * and the file-watch loop. Returns null if the path doesn't exist
 * (yet).
 */
export async function resolveCellDir(cellId: string): Promise<string | null> {
  const parts = parseCellId(cellId);
  if (parts === null) return null;
  const cellDir = join(RUN_ROOT, parts.runTs, parts.target, parts.condition);
  try {
    const st = await stat(cellDir);
    if (!st.isDirectory()) return null;
    return cellDir;
  } catch {
    return null;
  }
}

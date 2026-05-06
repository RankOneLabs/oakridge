/**
 * Cell discovery + event tailing.
 *
 * Reads from legit-biz-club's per-cell sidecars on disk:
 *   <run_root>/<run_ts>/<target_name>/<condition_name>/
 *     ├── <artifact_filename>     final artifact
 *     ├── events.jsonl            workspace event log (one JSON record/line)
 *     ├── commits/v0001.<ext> ... per-commit snapshots
 *     ├── eval_scores.json        present when grader-produced scores were persisted
 *     └── agent_memory/           per-agent SqliteStores (we ignore)
 *
 * Cell IDs are stable derivations of the on-disk path so they survive
 * across dashboard restarts and can be used as URL fragments. The
 * Python harness writes everything; the dashboard is purely a reader.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface CellEvent {
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface EvalScore {
  dimension: string;
  value: number;
  source: string;
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
 *
 * Resolved per call (NOT cached at module scope) so tests can override
 * via process.env.LBC_RUN_ROOT without ESM module-cache gymnastics.
 */
export function resolveRunRoot(): string {
  const fromEnv = process.env.LBC_RUN_ROOT;
  if (fromEnv) return resolve(fromEnv);
  // server.ts runs from lbc-dashboard/, so the sibling path is ../legit-biz-club/.run.
  return resolve(import.meta.dirname, "..", "..", "legit-biz-club", ".run");
}

/**
 * Build the cell_id from the path segments. URL-safe and resilient
 * to unusual characters in target/condition names: each segment is
 * encodeURIComponent'd, joined with ``:`` (which encodeURIComponent
 * escapes to ``%3A`` so it can't appear inside an encoded segment).
 *
 * The previous ``__`` delimiter would mis-split a target named e.g.
 * ``my__custom_target``. The harness doesn't validate target/
 * condition names, so a future operator-supplied name with any
 * delimiter would be a footgun.
 */
function cellIdFor(runTs: string, target: string, condition: string): string {
  return [runTs, target, condition].map(encodeURIComponent).join(":");
}

/**
 * Validate that a cell_id segment is safe to use in filesystem
 * paths. Reject empty, ``.``, ``..``, and anything containing
 * path separators — otherwise a crafted cell_id could escape
 * RUN_ROOT via getCellDetail / readArtifact / etc.
 */
function isSafeSegment(s: string): boolean {
  return s.length > 0 && s !== "." && s !== ".." && !s.includes("/") && !s.includes("\\");
}

function parseCellId(
  cellId: string,
): { runTs: string; target: string; condition: string } | null {
  const parts = cellId.split(":");
  if (parts.length !== 3) return null;
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    // Malformed percent-encoding (e.g., trailing % with no hex pair)
    // — treat as invalid rather than letting URIError escape.
    return null;
  }
  if (!decoded.every(isSafeSegment)) return null;
  return { runTs: decoded[0]!, target: decoded[1]!, condition: decoded[2]! };
}

/**
 * Walk the run-root and enumerate every cell directory. A cell is
 * any 3-deep dir under the run-root that contains an events.jsonl;
 * the absence of events.jsonl just means the cell hasn't started.
 *
 * Read-only: returns an empty list when the run-root doesn't exist
 * yet (rather than creating it). The dashboard is a viewer; the
 * Python harness owns directory creation.
 */
export async function listCells(): Promise<CellSummary[]> {
  const runRoot = resolveRunRoot();
  const summaries: CellSummary[] = [];
  const runDirs = await safeReaddir(runRoot);
  for (const runTs of runDirs) {
    const runDir = join(runRoot, runTs);
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

/**
 * Per-cell summary cache. The frontend polls /api/cells every 2s,
 * which currently kicks off ``summarize`` for every cell on the
 * disk; without caching, each call re-reads the full
 * ``events.jsonl`` to count lines and classify the tail. The list
 * of cells grows with every study run and the per-cell log grows
 * with every commit — at study scale this becomes O(total log
 * bytes) per poll. Caching by mtime turns that into O(1) on the
 * steady state and only re-reads when the file actually changes.
 */
interface SummaryCacheEntry {
  mtimeMs: number;
  eventCount: number;
  status: CellSummary["status"];
}
const summaryCache = new Map<string, SummaryCacheEntry>();

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
    const cached = summaryCache.get(eventsPath);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      eventCount = cached.eventCount;
      status = cached.status;
    } else {
      const contents = await readFile(eventsPath, "utf-8");
      // Parse once. eventCount counts what's actually parseable so
      // the sidebar matches the timeline (readEvents skips malformed
      // lines, and showing "10 events" while the UI renders 9 is
      // exactly the kind of inconsistency that ages into a real bug).
      const parsedKinds = contents
        .split("\n")
        .filter((l) => l.trim())
        .map(parseEventKind)
        .filter((k): k is string => k !== null);
      eventCount = parsedKinds.length;
      status = classifyStatusFromKinds(parsedKinds);
      summaryCache.set(eventsPath, { mtimeMs, eventCount, status });
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
    cell_dir: relative(resolveRunRoot(), cellDir),
    status,
    last_activity_ms: mtimeMs,
    event_count: eventCount,
  };
}

/**
 * Decide whether a cell is `ended` from the parsed event kinds in
 * order. A cell ends with one of two terminal patterns:
 *
 * - INCREMENTAL_ONLY → the very last event is `incremental_terminated`.
 * - INCREMENTAL_THEN_CONVERGE → the last event is `proposal_applied`
 *   AND it's preceded by `proposal_picked` (the consensus pick was
 *   applied; PR #26 made this the final emission).
 *
 * Naive substring matching is wrong: `proposal_applied` ALSO fires
 * for every commit during the incremental phase, so a mid-run cell
 * would be misclassified as ended. Look at the last kind specifically
 * and require the picked-then-applied pair for the consensus case.
 */
function classifyStatusFromKinds(kinds: string[]): CellSummary["status"] {
  if (kinds.length === 0) return "active";
  const last = kinds[kinds.length - 1];
  if (last === "incremental_terminated") return "ended";
  if (last === "proposal_applied" && kinds.length > 1) {
    if (kinds[kinds.length - 2] === "proposal_picked") return "ended";
  }
  return "active";
}

function parseEventKind(line: string): string | null {
  try {
    const obj = JSON.parse(line) as { kind?: unknown };
    return typeof obj.kind === "string" ? obj.kind : null;
  } catch {
    return null;
  }
}

/**
 * Read full detail for one cell — events + artifact filename +
 * commit count. The artifact's content is fetched separately so
 * a large artifact doesn't bloat list responses.
 */
export async function getCellDetail(cellId: string): Promise<CellDetail | null> {
  const parts = parseCellId(cellId);
  if (parts === null) return null;
  const cellDir = join(resolveRunRoot(), parts.runTs, parts.target, parts.condition);
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
  const known = new Set([
    "events.jsonl",
    "commits",
    "agent_memory",
    "eval_scores.json",
  ]);
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

/**
 * Read eval_scores.json sidecar. Returns null when no scores were
 * persisted for this cell — either the operator didn't wire a
 * ``grader_factory``, or the grader ran but produced no scores.
 * Per the harness contract (legit-biz-club README), consumers
 * shouldn't distinguish those cases; both surface as "no scores."
 *
 * Also returns null when the file is malformed or its shape is
 * wrong, and folds the degenerate "all entries failed coercion"
 * case into null too — so the public contract is simply
 * ``EvalScore[] (non-empty) | null``.
 */
export async function readEvalScores(
  cellId: string,
): Promise<EvalScore[] | null> {
  const parts = parseCellId(cellId);
  if (parts === null) return null;
  const path = join(
    resolveRunRoot(),
    parts.runTs,
    parts.target,
    parts.condition,
    "eval_scores.json",
  );
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const scores = (parsed as { scores?: unknown }).scores;
  if (!Array.isArray(scores)) return null;
  // Defensive coercion — a malformed entry shouldn't break the
  // whole list. Drop entries that don't have the right keys; trust
  // the harness's writer for the rest.
  const coerced = scores.flatMap((s: unknown) => {
    if (typeof s !== "object" || s === null) return [];
    const obj = s as { dimension?: unknown; value?: unknown; source?: unknown };
    if (
      typeof obj.dimension !== "string" ||
      typeof obj.value !== "number" ||
      typeof obj.source !== "string"
    ) {
      return [];
    }
    return [
      {
        dimension: obj.dimension,
        value: obj.value,
        source: obj.source,
      },
    ];
  });
  return coerced.length > 0 ? coerced : null;
}


export async function readArtifact(cellId: string): Promise<string | null> {
  const parts = parseCellId(cellId);
  if (parts === null) return null;
  const cellDir = join(resolveRunRoot(), parts.runTs, parts.target, parts.condition);
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
  const cellDir = join(resolveRunRoot(), parts.runTs, parts.target, parts.condition);
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
  const cellDir = join(resolveRunRoot(), parts.runTs, parts.target, parts.condition);
  try {
    const st = await stat(cellDir);
    if (!st.isDirectory()) return null;
    return cellDir;
  } catch {
    return null;
  }
}

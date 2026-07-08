/**
 * Cell discovery + event tailing.
 *
 * Reads from legit-biz-club's per-cell sidecars on disk:
 *   <run_root>/<run_ts>/<task_name>/<condition_name>/
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
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type {
  CellId,
  ConditionName,
  TargetName,
} from "../pwa/lib/ids";
import type {
  AgentModelSummary,
  CellDetail,
  CellEvent,
  CellRunMetadata,
  CellSummary,
  CommitSnapshot,
  EvalScore,
  GraderConfigDraft,
  GraderSummary,
  TaskBuiltinDetail,
  TaskDetail,
  TaskDraft,
  TaskSummary,
} from "./contracts";
import {
  GraderConfigDraftSchema,
  GraderSummarySchema,
  TaskDetailSchema,
  TaskDraftSchema,
  TaskSummarySchema,
} from "./contracts";
import {
  BUILTIN_GRADER_SUMMARIES,
  BUILTIN_TASK_DETAILS,
} from "./generated/task_catalog";
import { modelLabelFromCatalog } from "./generated/model_catalog";

export type { CellDetail, CellEvent, CellSummary, CommitSnapshot, EvalScore };

// Internal type for the disk-derived fields before archived/cleanable are annotated.
type RawSummary = Omit<CellSummary, "archived" | "cleanable">;

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
 * to unusual characters in task/condition names: each segment is
 * encodeURIComponent'd, joined with ``:`` (which encodeURIComponent
 * escapes to ``%3A`` so it can't appear inside an encoded segment).
 *
 * The previous ``__`` delimiter would mis-split a task named e.g.
 * ``my__custom_task``. The harness doesn't validate task/
 * condition names, so a future operator-supplied name with any
 * delimiter would be a footgun.
 */
export function cellIdFor(runTs: string, target: string, condition: string): CellId {
  return [runTs, target, condition]
    .map(encodeURIComponent)
    .join(":") as CellId;
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

export function parseCellId(
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

// Cells stale longer than this with no live run entry are cleanable (branch b).
export const STALE_MS = 5 * 60 * 1000;

// Dashboard-owned archive metadata. Never stored inside cell directories.
type ArchivedCellsIndex = { archived_cell_ids: string[] };

function resolveArchivedCellsIndexPath(): string {
  return join(resolveDashboardDataRoot(), "archived-cells.json");
}

async function readArchivedCellsIndex(): Promise<Set<string>> {
  const path = resolveArchivedCellsIndexPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[lbc-dashboard] failed to read archived-cells.json:", error);
    }
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[lbc-dashboard] archived-cells.json is malformed JSON; treating as empty");
    return new Set();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as ArchivedCellsIndex).archived_cell_ids) ||
    !(parsed as ArchivedCellsIndex).archived_cell_ids.every(
      (id) => typeof id === "string",
    )
  ) {
    console.warn("[lbc-dashboard] archived-cells.json has wrong shape; treating as empty");
    return new Set();
  }
  return new Set((parsed as ArchivedCellsIndex).archived_cell_ids);
}

async function writeArchivedCellsIndex(ids: Set<string>): Promise<void> {
  await mkdir(resolveDashboardDataRoot(), { recursive: true });
  const index: ArchivedCellsIndex = { archived_cell_ids: Array.from(ids) };
  await writeFile(
    resolveArchivedCellsIndexPath(),
    JSON.stringify(index, null, 2),
    "utf-8",
  );
}

// Live process ownership is the authoritative delete safety gate and must be
// consulted before event-derived status. Terminal coordination events (including
// ended/failed) can arrive while the child grading process is still running.
function computeCleanable(
  status: RawSummary["status"],
  cellId: string,
  lastActivityMs: number,
  liveCellIds: Set<string>,
  nowMs: number,
): boolean {
  if (liveCellIds.has(cellId)) return false;
  if (status === "ended" || status === "failed" || status === "cancelled") return true;
  // active/unknown: only cleanable once stale (handles crashed/abandoned runs).
  return nowMs - lastActivityMs > STALE_MS;
}

/**
 * Walk the run-root and enumerate every cell directory. A cell is
 * any 3-deep dir under the run-root that contains an events.jsonl;
 * the absence of events.jsonl just means the cell hasn't started.
 *
 * Read-only: returns an empty list when the run-root doesn't exist
 * yet (rather than creating it). The dashboard is a viewer; the
 * Python harness owns directory creation.
 *
 * liveCellIds — set of cell_ids with an active run (status === 'running')
 * from the run registry. Injected so store.ts stays registry-free and
 * the bun:test fixtures don't need to spin up a registry.
 * nowMs — injectable for deterministic staleness tests.
 */
export async function listCells(
  liveCellIds: Set<string> = new Set(),
  nowMs: number = Date.now(),
): Promise<CellSummary[]> {
  const [archivedIds, runDirs] = await Promise.all([
    readArchivedCellsIndex(),
    safeReaddir(resolveRunRoot()),
  ]);
  const runRoot = resolveRunRoot();
  const summaries: CellSummary[] = [];
  for (const runTs of runDirs) {
    const runDir = join(runRoot, runTs);
    const targetDirs = await safeReaddir(runDir);
    for (const target of targetDirs) {
      const targetDir = join(runDir, target);
      const conditionDirs = await safeReaddir(targetDir);
      for (const condition of conditionDirs) {
        const cellDir = join(targetDir, condition);
        const raw = await summarize(runTs, target, condition, cellDir);
        if (raw) {
          summaries.push(await annotate(raw, archivedIds, liveCellIds, nowMs));
        }
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
 *
 * firstIncrementalStartedPayload is cached alongside status/count so
 * deriveRunMetadata can read agent_ids without a second events.jsonl
 * read in getCellDetail.
 */
interface SummaryCacheEntry {
  mtimeMs: number;
  eventCount: number;
  status: CellSummary["status"];
  firstIncrementalStartedPayload: Record<string, unknown> | null;
}
const summaryCache = new Map<string, SummaryCacheEntry>();

function parseEventFull(
  line: string,
): { kind: string; payload: unknown } | null {
  try {
    const obj = JSON.parse(line) as { kind?: unknown; payload?: unknown };
    return typeof obj.kind === "string"
      ? { kind: obj.kind, payload: obj.payload }
      : null;
  } catch {
    return null;
  }
}

async function summarize(
  runTs: string,
  target: string,
  condition: string,
  cellDir: string,
): Promise<RawSummary | null> {
  const eventsPath = join(cellDir, "events.jsonl");
  let mtimeMs = 0;
  let eventCount = 0;
  let status: RawSummary["status"] = "active";
  let firstIncrementalStartedPayload: Record<string, unknown> | null = null;
  try {
    const st = await stat(eventsPath);
    mtimeMs = st.mtimeMs;
    const cached = summaryCache.get(eventsPath);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      eventCount = cached.eventCount;
      status = cached.status;
      firstIncrementalStartedPayload = cached.firstIncrementalStartedPayload;
    } else {
      const contents = await readFile(eventsPath, "utf-8");
      // Parse once. eventCount counts what's actually parseable so
      // the sidebar matches the timeline (readEvents skips malformed
      // lines, and showing "10 events" while the UI renders 9 is
      // exactly the kind of inconsistency that ages into a real bug).
      // We also capture the first incremental_started payload so
      // deriveRunMetadata can attribute agents without a second read.
      const parsedKinds: string[] = [];
      for (const l of contents.split("\n")) {
        if (!l.trim()) continue;
        const e = parseEventFull(l);
        if (e === null) continue;
        parsedKinds.push(e.kind);
        if (
          firstIncrementalStartedPayload === null &&
          e.kind === "incremental_started" &&
          typeof e.payload === "object" &&
          e.payload !== null &&
          !Array.isArray(e.payload)
        ) {
          firstIncrementalStartedPayload = e.payload as Record<string, unknown>;
        }
      }
      eventCount = parsedKinds.length;
      status = classifyStatusFromKinds(parsedKinds);
      summaryCache.set(eventsPath, {
        mtimeMs,
        eventCount,
        status,
        firstIncrementalStartedPayload,
      });
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
    // Filesystem directory names cross the brand boundary here.
    // From this point on the values carry ``TargetName`` / ``ConditionName``
    // so consumers can't accidentally swap them for unrelated strings.
    target_name: target as TargetName,
    condition_name: condition as ConditionName,
    cell_dir: relative(resolveRunRoot(), cellDir),
    status,
    last_activity_ms: mtimeMs,
    event_count: eventCount,
  };
}

/**
 * Classify a cell's lifecycle status from its parsed event kinds.
 *
 * Terminal patterns:
 * - INCREMENTAL_ONLY: last event is `incremental_terminated` → ended.
 * - INCREMENTAL_THEN_CONVERGE: last event is `proposal_applied` preceded
 *   by `proposal_picked` → ended.
 * - CELL_FAILED: last event is `cell_failed` → failed.
 * - CANCELLED: last event is `cell_cancelled` or `run_cancelled` → cancelled.
 * - CONSENSUS_REJECTED: last event is `consensus_rejected` or
 *   `proposal_rejected` → failed (consensus rejection is terminal
 *   failure; leaving it as active causes incorrect display and cleanup).
 *
 * `proposal_applied` during the incremental phase is NOT terminal — it
 * fires for every commit. Only the picked-then-applied pair is terminal.
 */
function classifyStatusFromKinds(kinds: string[]): RawSummary["status"] {
  if (kinds.length === 0) return "active";
  const last = kinds[kinds.length - 1];
  if (last === "incremental_terminated") return "ended";
  if (last === "cell_cancelled" || last === "run_cancelled") return "cancelled";
  if (last === "cell_failed") return "failed";
  if (last === "consensus_rejected" || last === "proposal_rejected") return "failed";
  if (last === "proposal_applied" && kinds.length > 1) {
    if (kinds[kinds.length - 2] === "proposal_picked") return "ended";
  }
  return "active";
}

/**
 * Annotate a raw disk summary with server-computed archived/cleanable fields.
 */
async function annotate(
  raw: RawSummary,
  archivedIds: Set<string>,
  liveCellIds: Set<string>,
  nowMs: number,
): Promise<CellSummary> {
  return {
    ...raw,
    archived: archivedIds.has(raw.cell_id),
    cleanable: computeCleanable(
      raw.status,
      raw.cell_id,
      raw.last_activity_ms,
      liveCellIds,
      nowMs,
    ),
  };
}

/**
 * Single-cell summary — disk fields + server-computed archived/cleanable.
 */
export async function getCellSummary(
  cellId: string,
  liveCellIds: Set<string> = new Set(),
  nowMs: number = Date.now(),
): Promise<CellSummary | null> {
  const parts = parseCellId(cellId);
  if (parts === null) return null;
  const cellDir = join(resolveRunRoot(), parts.runTs, parts.target, parts.condition);
  const raw = await summarize(parts.runTs, parts.target, parts.condition, cellDir);
  if (raw === null) return null;
  const archivedIds = await readArchivedCellsIndex();
  return annotate(raw, archivedIds, liveCellIds, nowMs);
}

/**
 * Read detail for one cell — artifact filename, commit count, and
 * run metadata. Events are excluded: the cell event timeline is
 * served exclusively through /api/cells/:cellId/events (SSE), which
 * avoids the O(N) events.jsonl read that detail polling previously
 * triggered on every refresh.
 */
export async function getCellDetail(
  cellId: string,
  liveCellIds: Set<string> = new Set(),
  nowMs: number = Date.now(),
): Promise<CellDetail | null> {
  const parts = parseCellId(cellId);
  if (parts === null) return null;
  const cellDir = join(resolveRunRoot(), parts.runTs, parts.target, parts.condition);
  // summarize() populates summaryCache, which deriveRunMetadata reads
  // for agent attribution — no second events.jsonl open needed.
  const raw = await summarize(parts.runTs, parts.target, parts.condition, cellDir);
  if (raw === null) return null;
  const [archivedIds, artifactFilename, commitCount] = await Promise.all([
    readArchivedCellsIndex(),
    detectArtifactFilename(cellDir),
    countCommits(cellDir),
  ]);
  const summary = await annotate(raw, archivedIds, liveCellIds, nowMs);
  const run_metadata = await deriveRunMetadata(resolveRunRoot(), parts.runTs, cellDir);
  return {
    ...summary,
    artifact_filename: artifactFilename,
    commit_count: commitCount,
    run_metadata,
  };
}

// ---------------------------------------------------------------------------
// Archive index mutations
// ---------------------------------------------------------------------------

/**
 * Add a cell to the archived-cells index. Idempotent.
 */
export async function addToArchivedCellsIndex(cellId: string): Promise<void> {
  const ids = await readArchivedCellsIndex();
  ids.add(cellId);
  await writeArchivedCellsIndex(ids);
}

/**
 * Remove a cell from the archived-cells index. Idempotent.
 */
export async function removeFromArchivedCellsIndex(cellId: string): Promise<void> {
  const ids = await readArchivedCellsIndex();
  ids.delete(cellId);
  await writeArchivedCellsIndex(ids);
}

/**
 * Resolve a cell's on-disk directory path (for the delete route).
 * Returns null only if cellId is invalid — does NOT check disk existence.
 */
export function resolveCellDirPath(cellId: string): string | null {
  const parts = parseCellId(cellId);
  if (parts === null) return null;
  return join(resolveRunRoot(), parts.runTs, parts.target, parts.condition);
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
  // know the filename a priori (task-dependent), so scan the dir
  // for the file that isn't a known sidecar.
  //
  // Also skip dotfiles and ``.tmp`` files: the harness's writers use
  // those for atomic-rename intermediates (eval-scores writer uses
  // ``.eval_scores.*.tmp``; Mediator uses ``<artifact>.tmp``). A
  // crash mid-write can leave one orphaned in the cell dir, and
  // readdir's non-deterministic order would otherwise let one of
  // those mis-resolve as the artifact.
  const known = new Set([
    "events.jsonl",
    "commits",
    "agent_memory",
    "eval_scores.json",
  ]);
  try {
    const entries = await readdir(cellDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (known.has(e.name)) continue;
      if (e.name.startsWith(".")) continue;
      if (e.name.endsWith(".tmp")) continue;
      return e.name;
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

// ---------------------------------------------------------------------------
// Run-metadata derivation
// ---------------------------------------------------------------------------

export function modelLabel(id: string): string {
  return modelLabelFromCatalog(id);
}

async function deriveRunMetadata(
  runRoot: string,
  runTs: string,
  cellDir: string,
): Promise<CellRunMetadata | null> {
  // Step 1: Read run-spec.json
  const specPath = join(runRoot, runTs, "run-spec.json");
  let specRaw: string;
  try {
    specRaw = await readFile(specPath, "utf-8");
  } catch {
    return null;
  }

  // Step 2: Parse and validate model_pool
  let modelPool: string[];
  try {
    const spec = JSON.parse(specRaw) as { model_pool?: unknown };
    if (
      !Array.isArray(spec.model_pool) ||
      spec.model_pool.length === 0 ||
      !spec.model_pool.every(
        (m): m is string => typeof m === "string" && m.length > 0,
      )
    ) {
      return null;
    }
    modelPool = spec.model_pool;
  } catch {
    return null;
  }

  // Step 3: Read from the summary cache populated by summarize().
  // getCellDetail calls summarize() before this function. If events.jsonl was
  // readable, the cache entry is warm and firstIncrementalStartedPayload is
  // set. If events.jsonl was absent or unreadable, summarize() took the catch
  // path and wrote nothing to summaryCache — the ?? null fallback below handles
  // that correctly without a second open.
  const eventsPath = join(cellDir, "events.jsonl");
  const cached = summaryCache.get(eventsPath);
  const firstStartedPayload = cached?.firstIncrementalStartedPayload ?? null;

  if (firstStartedPayload === null) {
    return { model_pool: modelPool, agents: [], attribution_source: "missing" };
  }

  const agentIds = firstStartedPayload.agent_ids;
  // Require every id to be a non-empty string. AgentModelSummarySchema
  // enforces agent_id.min(1), so an empty id would throw at the API
  // boundary (500) — treat malformed ids as missing attribution instead.
  if (
    !Array.isArray(agentIds) ||
    !agentIds.every((id): id is string => typeof id === "string" && id.length > 0)
  ) {
    return { model_pool: modelPool, agents: [], attribution_source: "missing" };
  }

  // Step 4: Map agent_id[i] -> model_pool[i % pool.length]
  const agents: AgentModelSummary[] = agentIds.map((agentId, i) => {
    const modelId = modelPool[i % modelPool.length] ?? null;
    return {
      agent_id: agentId,
      model_id: modelId,
      label: modelId !== null ? modelLabel(modelId) : agentId,
    };
  });

  return { model_pool: modelPool, agents, attribution_source: "run_spec_derived" };
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

// ---------------------------------------------------------------------------
// Built-in task + grader catalog
// ---------------------------------------------------------------------------

// BUILTIN_TASK_DETAILS and BUILTIN_GRADER_SUMMARIES come from the generated
// artifact imported at the top. To regenerate:
//   cd legit-biz-club && uv run python scripts/generate_dashboard_metadata.py

const BUILTIN_TASK_DETAILS_BY_NAME = new Map(
  BUILTIN_TASK_DETAILS.map((task) => [task.name, task]),
);

const BUILTIN_TASK_SUMMARIES: readonly TaskSummary[] = BUILTIN_TASK_DETAILS.map(
  (task) =>
    TaskSummarySchema.parse({
      name: task.name,
      artifact_type: task.artifact_type,
      artifact_filename: task.artifact_filename,
      has_grader: task.has_grader,
      grader_key: task.grader_key,
      source: task.source,
    }),
);

const BUILTIN_TASK_SUMMARIES_BY_NAME = new Map(
  BUILTIN_TASK_SUMMARIES.map((task) => [task.name, task]),
);

const BUILTIN_GRADER_SUMMARIES_BY_KEY = new Map(
  BUILTIN_GRADER_SUMMARIES.map((grader) => [grader.key, grader]),
);

export function listBuiltinTaskSummaries(): TaskSummary[] {
  return [...BUILTIN_TASK_SUMMARIES];
}

export function listBuiltinGraderSummaries(): GraderSummary[] {
  return [...BUILTIN_GRADER_SUMMARIES];
}

export function getBuiltinTaskSummary(name: string): TaskSummary | null {
  return BUILTIN_TASK_SUMMARIES_BY_NAME.get(name) ?? null;
}

export function getBuiltinTaskDetail(name: string): TaskBuiltinDetail | null {
  return BUILTIN_TASK_DETAILS_BY_NAME.get(name) ?? null;
}

export function getBuiltinGraderSummary(name: string): GraderSummary | null {
  return BUILTIN_GRADER_SUMMARIES_BY_KEY.get(name) ?? null;
}

// ---------------------------------------------------------------------------
// Dashboard-local task + grader config stores
// ---------------------------------------------------------------------------

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

const STORE_NAME_RE = /^[a-z][a-z0-9_]*$/;

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function err<T>(errors: string[]): ValidationResult<T> {
  return { ok: false, errors };
}

function isStoreName(value: string): boolean {
  return STORE_NAME_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesShape(expected: unknown, actual: unknown): boolean {
  if (expected === null) {
    return true;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return false;
    }
    return expected.every((child, index) =>
      matchesShape(child, actual[index]),
    );
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    if (expectedKeys.length !== actualKeys.length) return false;
    for (const key of expectedKeys) {
      if (!(key in actual)) return false;
      if (!matchesShape(expected[key], actual[key])) return false;
    }
    return true;
  }
  if (typeof expected === "string") return typeof actual === "string";
  if (typeof expected === "number") return typeof actual === "number";
  if (typeof expected === "boolean") return typeof actual === "boolean";
  return actual === expected;
}

export function validateTaskDraftJson(raw: unknown): ValidationResult<TaskDraft> {
  const parsed = TaskDraftSchema.safeParse(raw);
  if (!parsed.success) {
    return err(parsed.error.issues.map((issue) => issue.message));
  }
  return ok(parsed.data);
}

export function validateGraderConfigDraftJson(
  raw: unknown,
  task: TaskDraft,
  graderSummaries: readonly GraderSummary[],
): ValidationResult<GraderConfigDraft> {
  const parsed = GraderConfigDraftSchema.safeParse(raw);
  if (!parsed.success) {
    return err(parsed.error.issues.map((issue) => issue.message));
  }
  if (task.grader.kind !== "registered") {
    return err([
      `task ${task.name} has no registered grader; grader config is not allowed`,
    ]);
  }
  if (parsed.data.task_name !== task.name) {
    return err([
      `grader config for ${parsed.data.task_name} does not belong to task ${task.name}`,
    ]);
  }
  if (task.grader.key !== parsed.data.grader_key) {
    return err([
      `task ${task.name} expects grader ${task.grader.key}, got ${parsed.data.grader_key}`,
    ]);
  }
  const parsedGraderSummaries: GraderSummary[] = [];
  for (const grader of graderSummaries) {
    const parsedGrader = GraderSummarySchema.safeParse(grader);
    if (!parsedGrader.success) {
      return err(parsedGrader.error.issues.map((issue) => issue.message));
    }
    parsedGraderSummaries.push(parsedGrader.data);
  }
  const grader = parsedGraderSummaries.find(
    (entry) => entry.key === parsed.data.grader_key,
  );
  if (grader === undefined) {
    return err([`unknown grader key ${parsed.data.grader_key}`]);
  }
  if (!grader.supported_artifact_types.includes(task.artifact_type)) {
    return err([
      `grader ${grader.key} does not support ${task.artifact_type} artifacts`,
    ]);
  }
  if (
    grader.config_schema !== null &&
    !matchesShape(grader.config_schema, parsed.data.config)
  ) {
    return err([
      `config does not match the registered schema shape for grader ${grader.key}`,
    ]);
  }
  return ok(parsed.data);
}

export function resolveDashboardDataRoot(): string {
  const fromEnv = process.env.LBC_DASHBOARD_DATA_ROOT;
  if (fromEnv) return resolve(fromEnv);
  return resolve(import.meta.dirname, "..", "data");
}

function resolveTasksDir(): string {
  return join(resolveDashboardDataRoot(), "tasks");
}

function resolveGraderConfigsDir(): string {
  return join(resolveDashboardDataRoot(), "grader-configs");
}

function taskDraftPath(name: string): string {
  return join(resolveTasksDir(), `${name}.json`);
}

function graderConfigDraftPath(name: string): string {
  return join(resolveGraderConfigsDir(), `${name}.json`);
}

function validateStoreName(name: string): string | null {
  const trimmed = name.trim();
  if (!isStoreName(trimmed)) return null;
  return trimmed;
}

async function readJson<T>(
  path: string,
  parser: (raw: unknown) => ValidationResult<T>,
): Promise<T | null> {
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
  const validated = parser(parsed);
  return validated.ok ? validated.value : null;
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function taskSummaryForDraft(task: TaskDraft): TaskSummary {
  return TaskSummarySchema.parse({
    name: task.name,
    artifact_type: task.artifact_type,
    artifact_filename: task.artifact_filename,
    has_grader: task.grader.kind === "registered",
    grader_key: task.grader.kind === "registered" ? task.grader.key : null,
    source: "local",
  });
}

export async function listTaskDrafts(): Promise<TaskDraft[]> {
  const files = await listJsonFiles(resolveTasksDir());
  const tasks: TaskDraft[] = [];
  for (const filename of files) {
    if (!filename.endsWith(".json")) continue;
    const expectedName = filename.slice(0, -5);
    const task = await readJson(
      join(resolveTasksDir(), filename),
      validateTaskDraftJson,
    );
    if (task !== null && task.name === expectedName) tasks.push(task);
  }
  tasks.sort((a, b) => a.name.localeCompare(b.name));
  return tasks;
}

export async function listTaskSummaries(): Promise<TaskSummary[]> {
  const drafts = await listTaskDrafts();
  return drafts.map(taskSummaryForDraft);
}

function taskDetailForDraft(task: TaskDraft): TaskDetail {
  return TaskDetailSchema.parse({
    ...task,
    has_grader: task.grader.kind === "registered",
    grader_key: task.grader.kind === "registered" ? task.grader.key : null,
    source: "local",
  });
}

export async function listAllTaskSummaries(): Promise<TaskSummary[]> {
  const locals = await listTaskDrafts();
  for (const task of locals) {
    if (getBuiltinTaskSummary(task.name) !== null) {
      throw new Error(
        `local task ${task.name} collides with built-in task names`,
      );
    }
  }
  return [
    ...listBuiltinTaskSummaries(),
    ...locals.map(taskSummaryForDraft),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTaskDraft(name: string): Promise<TaskDraft | null> {
  const validated = validateStoreName(name);
  if (validated === null) return null;
  const task = await readJson(taskDraftPath(validated), validateTaskDraftJson);
  return task !== null && task.name === validated ? task : null;
}

export async function upsertTaskDraft(task: TaskDraft): Promise<TaskDraft> {
  const parsed = TaskDraftSchema.parse(task);
  await mkdir(resolveTasksDir(), { recursive: true });
  await writeFile(taskDraftPath(parsed.name), JSON.stringify(parsed, null, 2), "utf-8");
  return parsed;
}

export async function deleteTaskDraft(name: string): Promise<boolean> {
  const validated = validateStoreName(name);
  if (validated === null) return false;
  const path = taskDraftPath(validated);
  try {
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

export async function getTaskDetail(name: string): Promise<TaskDetail | null> {
  const validated = validateStoreName(name);
  if (validated === null) return null;
  const local = await getTaskDraft(validated);
  if (local !== null) {
    if (getBuiltinTaskSummary(validated) !== null) {
      throw new Error(
        `local task ${validated} collides with built-in task names`,
      );
    }
    return taskDetailForDraft(local);
  }
  const builtin = getBuiltinTaskDetail(validated);
  return builtin !== null ? TaskDetailSchema.parse(builtin) : null;
}

export function getTaskSummary(name: string): TaskSummary | null {
  return getBuiltinTaskSummary(name);
}

export async function resolveTaskSummary(name: string): Promise<TaskSummary | null> {
  const validated = validateStoreName(name);
  if (validated === null) return null;
  const local = await getTaskDraft(validated);
  if (local !== null) {
    if (getBuiltinTaskSummary(validated) !== null) {
      throw new Error(
        `local task ${validated} collides with built-in task names`,
      );
    }
    return taskSummaryForDraft(local);
  }
  return getBuiltinTaskSummary(validated);
}

export function resolveTaskDetail(name: string): Promise<TaskDetail | null> {
  return getTaskDetail(name);
}

export async function listGraderConfigDrafts(): Promise<GraderConfigDraft[]> {
  const files = await listJsonFiles(resolveGraderConfigsDir());
  const configs: GraderConfigDraft[] = [];
  for (const filename of files) {
    if (!filename.endsWith(".json")) continue;
    const expectedTaskName = filename.slice(0, -5);
    const config = await readJson(
      join(resolveGraderConfigsDir(), filename),
      (raw): ValidationResult<GraderConfigDraft> => {
        const parsed = GraderConfigDraftSchema.safeParse(raw);
        if (!parsed.success) {
          return err(parsed.error.issues.map((issue) => issue.message));
        }
        return ok(parsed.data);
      },
    );
    if (config !== null && config.task_name === expectedTaskName) {
      configs.push(config);
    }
  }
  configs.sort((a, b) => a.task_name.localeCompare(b.task_name));
  return configs;
}

export async function getGraderConfigDraft(
  taskName: string,
): Promise<GraderConfigDraft | null> {
  const validated = validateStoreName(taskName);
  if (validated === null) return null;
  const config = await readJson(
    graderConfigDraftPath(validated),
    (raw): ValidationResult<GraderConfigDraft> => {
      const parsed = GraderConfigDraftSchema.safeParse(raw);
      if (!parsed.success) {
        return err(parsed.error.issues.map((issue) => issue.message));
      }
      return ok(parsed.data);
    },
  );
  return config !== null && config.task_name === validated ? config : null;
}

export async function upsertGraderConfigDraft(
  config: GraderConfigDraft,
): Promise<GraderConfigDraft> {
  const parsed = GraderConfigDraftSchema.parse(config);
  await mkdir(resolveGraderConfigsDir(), { recursive: true });
  await writeFile(
    graderConfigDraftPath(parsed.task_name),
    JSON.stringify(parsed, null, 2),
    "utf-8",
  );
  return parsed;
}

export async function deleteGraderConfigDraft(
  taskName: string,
): Promise<boolean> {
  const validated = validateStoreName(taskName);
  if (validated === null) return false;
  const path = graderConfigDraftPath(validated);
  try {
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

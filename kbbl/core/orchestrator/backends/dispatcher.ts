import type { Database } from "bun:sqlite";
import type { ExecutionBackend, InputRef, StageRow } from "./interface";
import { loadPrompt, renderPrompt } from "./prompt-loader";
import { listCohortsByPlan, listDependenciesByPlan } from "../../db/cohorts";
import type { Epic } from "../../db/epics";
import { listResolvedDiscrepanciesBySpec } from "../../db/spec-discrepancies";
import { getEpicBySpec } from "../../db/epics";
import type { Cohort, CohortDependency } from "../../types/task-tracker";
import type { RuntimeModelSelection } from "../../runtime";
import { runExclusive } from "./keyed-mutex";
import {
  claimDispatch,
  formatAttemptSuffix,
  getActiveAttempt,
  markAttemptRunning,
  markAttemptFailed,
  markAttemptSucceeded,
  updateAttemptBranchInfo,
  type DispatchAttempt,
} from "../../db/dispatch-attempts";

/**
 * Thrown by dispatcher.dispatch() when another attempt is already
 * dispatching or running for the same entity/stage. Callers can catch this
 * to surface the conflict to the operator (HTTP 409) or log it and return
 * without spawning a duplicate session (event hooks).
 */
export class DispatchConflictError extends Error {
  constructor(public readonly activeAttempt: DispatchAttempt) {
    super(
      `dispatch conflict: attempt ${activeAttempt.id} is already ${activeAttempt.status} for ${activeAttempt.entity_kind}/${activeAttempt.entity_id} stage=${activeAttempt.stage}`,
    );
    this.name = "DispatchConflictError";
  }
}

interface DispatcherDeps {
  db: Database;
  backends: Record<string, ExecutionBackend>;
  kbblUrl: string;
}

interface Dispatcher {
  dispatch(stageName: string, inputId: string): Promise<string>;
}

// ---- SQL helpers ----

function getStage(db: Database, name: string): StageRow | null {
  return (
    db
      .prepare<StageRow, [string]>("SELECT * FROM stages WHERE name = ?")
      .get(name) ?? null
  );
}

interface ProjectRow {
  id: string;
  name: string;
  repo_path: string;
}

type StageRole = "planner" | "worker";

export const UNKNOWN_STAGE_ERROR_PREFIX = 'unknown stage "';

const STAGE_ROLE_BY_NAME: Record<string, StageRole> = {
  spec_analyzer: "planner",
  plan_writer: "planner",
  brief_writer: "planner",
  assessor: "planner",
  build: "worker",
};

function supportedStageRoleMappings(): string {
  return Object.entries(STAGE_ROLE_BY_NAME)
    .map(([stageName, role]) => `${stageName}→${role}`)
    .join(", ");
}

function resolveStageRole(stageName: string): StageRole {
  const role = STAGE_ROLE_BY_NAME[stageName];
  if (!role) {
    throw new Error(
      `${UNKNOWN_STAGE_ERROR_PREFIX}${stageName}" for epic-owned dispatch; supported stage-role mappings: ${supportedStageRoleMappings()}`,
    );
  }
  return role;
}

function getProjectForSpec(db: Database, spec_id: string): ProjectRow | null {
  return (
    db
      .prepare<ProjectRow, [string]>(
        `SELECT p.id, p.name, p.repo_path
           FROM projects p
           JOIN specs s ON s.project_id = p.id
          WHERE s.id = ?`,
      )
      .get(spec_id) ?? null
  );
}

function getProjectForCohort(db: Database, cohort_id: string): ProjectRow | null {
  return (
    db
      .prepare<ProjectRow, [string]>(
        `SELECT p.id, p.name, p.repo_path
           FROM projects p
           JOIN specs s ON s.project_id = p.id
           JOIN plans pl ON pl.spec_id = s.id
           JOIN cohorts c ON c.plan_id = pl.id
          WHERE c.id = ?`,
      )
      .get(cohort_id) ?? null
  );
}

function getProjectForBrief(db: Database, brief_id: string): ProjectRow | null {
  return (
    db
      .prepare<ProjectRow, [string]>(
        `SELECT p.id, p.name, p.repo_path
           FROM projects p
           JOIN specs s ON s.project_id = p.id
           JOIN plans pl ON pl.spec_id = s.id
           JOIN cohorts c ON c.plan_id = pl.id
           JOIN briefs b ON b.cohort_id = c.id
          WHERE b.id = ?`,
      )
      .get(brief_id) ?? null
  );
}

function getProjectForPlan(db: Database, plan_id: string): ProjectRow | null {
  return (
    db
      .prepare<ProjectRow, [string]>(
        `SELECT p.id, p.name, p.repo_path
           FROM projects p
           JOIN specs s ON s.project_id = p.id
           JOIN plans pl ON pl.spec_id = s.id
          WHERE pl.id = ?`,
      )
      .get(plan_id) ?? null
  );
}

function resolveEpicForSpec(db: Database, spec_id: string): Epic | null {
  return getEpicBySpec(db, spec_id);
}

function resolveEpicForPlan(db: Database, plan_id: string): Epic | null {
  const row = db
    .prepare<{ spec_id: string }, [string]>(
      `SELECT pl.spec_id
         FROM plans pl
        WHERE pl.id = ?`,
    )
    .get(plan_id);
  return row ? getEpicBySpec(db, row.spec_id) : null;
}

function resolveEpicForCohort(db: Database, cohort_id: string): Epic | null {
  const row = db
    .prepare<{ spec_id: string }, [string]>(
      `SELECT pl.spec_id
         FROM plans pl
         JOIN cohorts c ON c.plan_id = pl.id
        WHERE c.id = ?`,
    )
    .get(cohort_id);
  return row ? getEpicBySpec(db, row.spec_id) : null;
}

function resolveEpicForBrief(db: Database, brief_id: string): Epic | null {
  const row = db
    .prepare<{ spec_id: string }, [string]>(
      `SELECT pl.spec_id
         FROM plans pl
         JOIN cohorts c ON c.plan_id = pl.id
         JOIN briefs b ON b.cohort_id = c.id
        WHERE b.id = ?`,
    )
    .get(brief_id);
  return row ? getEpicBySpec(db, row.spec_id) : null;
}

function modelSelectionForEpicStage(epic: Epic, stageName: string): RuntimeModelSelection {
  switch (resolveStageRole(stageName)) {
    case "planner":
      return epic.planner_model_selection;
    case "worker":
      return epic.worker_model_selection;
  }
}

// ---- Session name builders ----

/**
 * Squash a spec title down to something safe for use in a session label —
 * lowercase, alnum+underscore only, length-capped so the full name stays
 * readable in the sidebar. If the title sanitizes to empty (all-punct
 * titles like "!!!"), fall back to the caller's artifact id so distinct
 * artifacts don't collide on a shared literal.
 */
function sanitizeForName(s: string, fallbackId: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (out.length === 0) return fallbackId.slice(0, 8);
  return out.length > 40 ? out.slice(0, 40) : out;
}

interface BriefIdentityContext {
  spec_id: string;
  cohort_id: string;
  cohort_position: number;
  cohort_title: string;
}

/**
 * Resolve the full cohort/spec context needed for epic identity in the brief
 * dispatch case. Single JOIN query — no multi-step round trips.
 */
function getBriefIdentityContext(
  db: Database,
  brief_id: string,
): BriefIdentityContext | null {
  const row = db
    .prepare<BriefIdentityContext, [string]>(
      `SELECT s.id AS spec_id, c.id AS cohort_id, c.position AS cohort_position, c.title AS cohort_title
         FROM specs s
         JOIN plans pl ON pl.spec_id = s.id
         JOIN cohorts c ON c.plan_id = pl.id
         JOIN briefs b ON b.cohort_id = c.id
        WHERE b.id = ?`,
    )
    .get(brief_id);
  return row ?? null;
}

function resolveEpicBranchForBrief(db: Database, brief_id: string): string {
  const ctx = getBriefIdentityContext(db, brief_id);
  if (!ctx) throw new Error(`brief/cohort/spec context not found for brief ${brief_id}`);
  const epic = getEpicBySpec(db, ctx.spec_id);
  if (!epic) throw new Error(`epic not found for spec ${ctx.spec_id}`);
  return `epic/${sanitizeForName(epic.title, epic.id)}`;
}

async function lsRemoteEpicBranch(epicBranch: string, workdir: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", "-C", workdir, "ls-remote", "origin", `refs/heads/${epicBranch}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `git ls-remote origin refs/heads/${epicBranch} failed (exit ${code}): ${err.trim()}`,
    );
  }
  return out.trim();
}

async function fetchEpicBranchLocally(epicBranch: string, workdir: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["git", "-C", workdir, "fetch", "origin", epicBranch],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `git fetch origin ${epicBranch} failed (exit ${code}): ${err.trim()}`,
    );
  }
}

/**
 * Idempotently ensure `epic/<slug>` exists on origin and is current in local
 * remote-tracking refs (so subsequent `git rev-parse origin/<epicBranch>`
 * inside createWorktree succeeds).
 *
 * When the branch already exists on origin, only a local fetch is done.
 * When absent, it is seeded from origin/main (fetch main → push → fetch back).
 * A concurrent push failure is re-checked: if the branch now exists the race
 * resolved benignly and we proceed with a local fetch.
 */
export async function ensureEpicBranchExists(epicBranch: string, workdir: string): Promise<void> {
  // Serialize per-workdir. Two build dispatches for the same epic share a
  // workdir and would otherwise run `git fetch origin <epicBranch>` at the same
  // time, racing to update refs/remotes/origin/<epicBranch>. The loser fails
  // with "cannot lock ref ... unable to update local ref" and its build session
  // never launches. Same epic ⇒ same workdir ⇒ same lock key, so the fetches
  // queue; distinct repos still run in parallel.
  return runExclusive(workdir, () => ensureEpicBranchExistsUnlocked(epicBranch, workdir));
}

async function ensureEpicBranchExistsUnlocked(epicBranch: string, workdir: string): Promise<void> {
  const existingOut = await lsRemoteEpicBranch(epicBranch, workdir);

  if (existingOut !== "") {
    // Branch already on origin — just ensure local tracking ref is current.
    await fetchEpicBranchLocally(epicBranch, workdir);
    return;
  }

  // Branch absent — seed it from origin/main.
  const fetchMain = Bun.spawn({
    // Use an explicit refspec so the fetched remote head always replaces the
    // local origin/main tracking ref. The epic branch must never inherit a
    // stale local main branch (or a stale tracking ref under unusual fetch
    // configuration).
    cmd: [
      "git",
      "-C",
      workdir,
      "fetch",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, fetchErr, fetchCode] = await Promise.all([
    new Response(fetchMain.stdout).text(),
    new Response(fetchMain.stderr).text(),
    fetchMain.exited,
  ]);
  if (fetchCode !== 0) {
    throw new Error(
      `git fetch origin +refs/heads/main:refs/remotes/origin/main failed (exit ${fetchCode}): ${fetchErr.trim()}`,
    );
  }

  const push = Bun.spawn({
    cmd: ["git", "-C", workdir, "push", "origin", `origin/main:refs/heads/${epicBranch}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, pushErr, pushCode] = await Promise.all([
    new Response(push.stdout).text(),
    new Response(push.stderr).text(),
    push.exited,
  ]);
  if (pushCode !== 0) {
    // Concurrent push may have raced us. Re-check before throwing.
    const recheck = await lsRemoteEpicBranch(epicBranch, workdir);
    if (recheck === "") {
      throw new Error(
        `git push origin origin/main:refs/heads/${epicBranch} failed (exit ${pushCode}): ${pushErr.trim()}`,
      );
    }
    // Another writer seeded the branch; fall through to local fetch.
  }

  await fetchEpicBranchLocally(epicBranch, workdir);
}

/**
 * Assessor variant of {@link ensureEpicBranchExists}. The epic branch must
 * already exist on origin — the cohorts pushed to it before the assessor runs.
 * Unlike the build path we must NOT seed it from origin/main: doing so would
 * silently base the assessor's review worktree on main and defeat the whole
 * point of reviewing the merged cohort work. Fail fast if it's absent, then
 * refresh the local tracking ref so `git rev-parse origin/<epicBranch>`
 * succeeds in createWorktree.
 */
export async function requireEpicBranchExists(epicBranch: string, workdir: string): Promise<void> {
  return runExclusive(workdir, async () => {
    const existing = await lsRemoteEpicBranch(epicBranch, workdir);
    if (existing === "") {
      throw new Error(
        `assessor: epic branch ${epicBranch} does not exist on origin — refusing to review against main`,
      );
    }
    await fetchEpicBranchLocally(epicBranch, workdir);
  });
}

function getSpecTitleForCohort(db: Database, cohort_id: string): string | null {
  const row = db
    .prepare<{ title: string }, [string]>(
      `SELECT s.title FROM specs s
         JOIN plans pl ON pl.spec_id = s.id
         JOIN cohorts c ON c.plan_id = pl.id
        WHERE c.id = ?`,
    )
    .get(cohort_id);
  return row?.title ?? null;
}

function getCohortContextForBrief(
  db: Database,
  brief_id: string,
): { position: number; spec_title: string } | null {
  const row = db
    .prepare<{ position: number; title: string }, [string]>(
      `SELECT c.position, s.title FROM specs s
         JOIN plans pl ON pl.spec_id = s.id
         JOIN cohorts c ON c.plan_id = pl.id
         JOIN briefs b ON b.cohort_id = c.id
        WHERE b.id = ?`,
    )
    .get(brief_id);
  return row ? { position: row.position, spec_title: row.title } : null;
}

function buildSessionNameForSpec(db: Database, spec_id: string, stageName: string): string {
  const row = db
    .prepare<{ title: string }, [string]>("SELECT title FROM specs WHERE id = ?")
    .get(spec_id);
  const slug = sanitizeForName(row?.title ?? "", spec_id);
  return `${stageName}_${slug}`;
}

function buildSessionNameForCohort(db: Database, cohort_id: string, stageName: string): string {
  const cohortRow = db
    .prepare<{ position: number }, [string]>("SELECT position FROM cohorts WHERE id = ?")
    .get(cohort_id);
  const specTitle = getSpecTitleForCohort(db, cohort_id);
  const slug = sanitizeForName(specTitle ?? "", cohort_id);
  const pos = cohortRow?.position ?? 0;
  return `${stageName}_cohort_${pos}_${slug}`;
}

function buildSessionNameForBrief(db: Database, brief_id: string, stageName: string): string {
  const ctx = getCohortContextForBrief(db, brief_id);
  // Map stage name "build" → "builder" prefix for the session label, since
  // operators read "builder_cohort_…" more naturally than "build_cohort_…"
  // when scanning the list view. Other stages keep their stage name as-is.
  const prefix = stageName === "build" ? "builder" : stageName;
  if (!ctx) return `${prefix}_${brief_id.slice(0, 8)}`;
  const slug = sanitizeForName(ctx.spec_title, brief_id);
  return `${prefix}_cohort_${ctx.position}_${slug}`;
}

function buildSessionNameForPlan(db: Database, plan_id: string, stageName: string): string {
  const row = db
    .prepare<{ title: string }, [string]>(
      `SELECT s.title FROM specs s JOIN plans pl ON pl.spec_id = s.id WHERE pl.id = ?`,
    )
    .get(plan_id);
  const slug = sanitizeForName(row?.title ?? "", plan_id);
  return `${stageName}_${slug}`;
}

// ---- Slot builders ----

const BRIEF_FORMAT_GUIDE =
  "The brief must close every decision. Each `decisions_made` entry needs a `decision` field (what was decided) and a `rationale` field (why). Each `approaches_rejected` entry needs an `approach` field and a `reason` field. The `next_action` field must describe the immediate, concrete first step the build agent should take. Do not leave any field as a question or placeholder.";

function buildPlanContext(db: Database, cohort_id: string): string {
  const cohortRow = db
    .prepare<{ plan_id: string }, [string]>("SELECT plan_id FROM cohorts WHERE id = ?")
    .get(cohort_id);
  if (!cohortRow) return "(no plan context available)";

  interface SiblingRow { id: string; title: string; position: number; notes: string | null }
  const siblings = db
    .prepare<SiblingRow, [string]>(
      "SELECT id, title, position, notes FROM cohorts WHERE plan_id = ? ORDER BY position, id",
    )
    .all(cohortRow.plan_id);

  interface DepRow { from_cohort_id: string; to_cohort_id: string }
  const deps = db
    .prepare<DepRow, [string]>(
      `SELECT cd.from_cohort_id, cd.to_cohort_id
         FROM cohort_dependencies cd
         JOIN cohorts c ON c.id = cd.from_cohort_id
        WHERE c.plan_id = ?`,
    )
    .all(cohortRow.plan_id);

  const titleById = new Map(siblings.map((s) => [s.id, s.title]));

  const lines: string[] = ["Cohorts in this plan:"];
  for (const s of siblings) {
    const marker = s.id === cohort_id ? " ← current" : "";
    lines.push(`  [${s.position}] ${s.title} (id: ${s.id})${marker}`);
    if (s.notes) lines.push(`       notes: ${s.notes}`);
  }

  if (deps.length > 0) {
    lines.push("\nDependency edges (from must complete before to):");
    for (const d of deps) {
      lines.push(`  ${titleById.get(d.from_cohort_id) ?? d.from_cohort_id} → ${titleById.get(d.to_cohort_id) ?? d.to_cohort_id}`);
    }
  }

  return lines.join("\n");
}

function renderBrief(db: Database, brief_id: string): string {
  interface BriefDataRow {
    goal: string;
    files_in_scope: string;
    decisions_made: string;
    approaches_rejected: string;
    next_action: string;
  }
  const row = db
    .prepare<BriefDataRow, [string]>(
      "SELECT goal, files_in_scope, decisions_made, approaches_rejected, next_action FROM briefs WHERE id = ?",
    )
    .get(brief_id);
  if (!row) return "(brief not found)";

  const files: string[] = JSON.parse(row.files_in_scope);
  const decisions: { decision: string; rationale: string }[] = JSON.parse(row.decisions_made);
  const rejected: { approach: string; reason: string }[] = JSON.parse(row.approaches_rejected);

  const lines: string[] = [
    `## Goal\n\n${row.goal}`,
    `## Files in scope\n\n${files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "(none listed)"}`,
    `## Decisions made\n\n${decisions.length > 0 ? decisions.map((d) => `- **${d.decision}**: ${d.rationale}`).join("\n") : "(none)"}`,
    `## Approaches rejected\n\n${rejected.length > 0 ? rejected.map((a) => `- **${a.approach}**: ${a.reason}`).join("\n") : "(none)"}`,
    `## Next action\n\n${row.next_action}`,
  ];
  return lines.join("\n\n");
}

// ---- Slot resolution per stage ----

function buildSlotsForSpec(db: Database, spec_id: string, kbblUrl: string): Record<string, string> {
  interface SpecRow { id: string; title: string; notes: string | null }
  const spec = db.prepare<SpecRow, [string]>("SELECT id, title, COALESCE(final_notes, notes) AS notes FROM specs WHERE id = ?").get(spec_id);
  if (!spec) throw new Error(`spec not found: ${spec_id}`);
  const project = getProjectForSpec(db, spec_id);
  if (!project) throw new Error(`project not found for spec ${spec_id}`);

  const resolutions = listResolvedDiscrepanciesBySpec(db, spec_id);
  let discrepancyResolutions: string;
  if (resolutions.length === 0) {
    discrepancyResolutions = "(none — spec analyzed clean or pre-resolutions spec)";
  } else {
    discrepancyResolutions = resolutions
      .map((r, i) => [
        `### ${i + 1}. ${r.spec_assumption}`,
        "",
        `**Code reality:** ${r.code_reality}`,
        "",
        `**Resolution:** ${r.resolution ?? "(no resolution recorded)"}`,
      ].join("\n"))
      .join("\n\n");
  }

  return {
    SPEC_ID: spec.id,
    SPEC_TITLE: spec.title,
    SPEC_NOTES: spec.notes ?? "(no notes)",
    DISCREPANCY_RESOLUTIONS: discrepancyResolutions,
    REPO_PATH: project.repo_path,
    KBBL_URL: kbblUrl,
  };
}

function buildSlotsForCohort(db: Database, cohort_id: string, kbblUrl: string): Record<string, string> {
  interface CohortRow { id: string; title: string; notes: string | null }
  const cohort = db.prepare<CohortRow, [string]>("SELECT id, title, notes FROM cohorts WHERE id = ?").get(cohort_id);
  if (!cohort) throw new Error(`cohort not found: ${cohort_id}`);
  return {
    COHORT_ID: cohort.id,
    COHORT_TITLE: cohort.title,
    COHORT_NOTES: cohort.notes ?? "(no notes)",
    PLAN_CONTEXT: buildPlanContext(db, cohort_id),
    KBBL_URL: kbblUrl,
    BRIEF_FORMAT_GUIDE: BRIEF_FORMAT_GUIDE,
  };
}

export function buildSlotsForBrief(db: Database, brief_id: string, kbblUrl: string): Record<string, string> {
  const project = getProjectForBrief(db, brief_id);
  if (!project) throw new Error(`project not found for brief ${brief_id}`);
  const briefRow = db
    .prepare<{ cohort_id: string }, [string]>("SELECT cohort_id FROM briefs WHERE id = ?")
    .get(brief_id);
  if (!briefRow) throw new Error(`brief not found: ${brief_id}`);
  return {
    BRIEF_ID: brief_id,
    COHORT_ID: briefRow.cohort_id,
    BRIEF_RENDERED: renderBrief(db, brief_id),
    REPO_PATH: project.repo_path,
    KBBL_URL: kbblUrl,
    EPIC_BRANCH: resolveEpicBranchForBrief(db, brief_id),
  };
}

function toposortCohorts(cohorts: Cohort[], deps: CohortDependency[], plan_id: string): Cohort[] {
  const inDegree = new Map<string, number>(cohorts.map((c) => [c.id, 0]));
  const adjFrom = new Map<string, string[]>(cohorts.map((c) => [c.id, []]));
  for (const dep of deps) {
    inDegree.set(dep.to_cohort_id, (inDegree.get(dep.to_cohort_id) ?? 0) + 1);
    adjFrom.get(dep.from_cohort_id)?.push(dep.to_cohort_id);
  }

  const topoSort = (a: { position: number; id: string }, b: { position: number; id: string }) =>
    a.position - b.position || a.id.localeCompare(b.id);

  const queue = cohorts.filter((c) => inDegree.get(c.id) === 0).sort(topoSort);
  const sorted: Cohort[] = [];
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));

  while (queue.length > 0) {
    queue.sort(topoSort);
    const curr = queue.shift();
    if (!curr) break;
    sorted.push(curr);
    for (const toId of adjFrom.get(curr.id) ?? []) {
      const newDeg = (inDegree.get(toId) ?? 0) - 1;
      inDegree.set(toId, newDeg);
      if (newDeg === 0) {
        const next = cohortById.get(toId);
        if (!next) throw new Error(`dependency references unknown cohort ${toId} in plan ${plan_id}`);
        queue.push(next);
      }
    }
  }

  if (sorted.length !== cohorts.length) {
    throw new Error(`dependency cycle detected in plan ${plan_id}`);
  }

  return sorted;
}

function buildSlotsForPlan(db: Database, plan_id: string, kbblUrl: string): Record<string, string> {
  interface PlanSpecRow { spec_id: string; spec_title: string; spec_notes: string | null }
  const planRow = db
    .prepare<PlanSpecRow, [string]>(
      `SELECT pl.spec_id, s.title AS spec_title, COALESCE(s.final_notes, s.notes) AS spec_notes
         FROM plans pl
         JOIN specs s ON s.id = pl.spec_id
        WHERE pl.id = ?`,
    )
    .get(plan_id);
  if (!planRow) throw new Error(`plan not found: ${plan_id}`);

  const cohorts = listCohortsByPlan(db, plan_id);
  const deps = listDependenciesByPlan(db, plan_id);
  const sorted = toposortCohorts(cohorts, deps, plan_id);

  const cohortLines: string[] = [];
  for (const c of sorted) {
    cohortLines.push(`[${c.position}] ${c.title} (id: ${c.id})`);
    if (c.notes) cohortLines.push(`       notes: ${c.notes}`);
  }

  const titleById = new Map(cohorts.map((c) => [c.id, c.title]));
  const depLines =
    deps.length > 0
      ? deps.map((d) => `${titleById.get(d.from_cohort_id) ?? d.from_cohort_id} → ${titleById.get(d.to_cohort_id) ?? d.to_cohort_id}`)
      : ["(none)"];

  return {
    PLAN_ID: plan_id,
    PLAN_TITLE: planRow.spec_title,
    SPEC_NOTES: planRow.spec_notes ?? "(no notes)",
    COHORTS: cohortLines.join("\n"),
    PLAN_DEPENDENCIES: depLines.join("\n"),
    KBBL_URL: kbblUrl,
    BRIEF_FORMAT_GUIDE: BRIEF_FORMAT_GUIDE,
  };
}

function buildSlotsForPlanResults(db: Database, plan_id: string, kbblUrl: string): Record<string, string> {
  interface PlanSpecRow { spec_id: string; spec_title: string; spec_notes: string | null }
  const planRow = db
    .prepare<PlanSpecRow, [string]>(
      `SELECT pl.spec_id, s.title AS spec_title, COALESCE(s.final_notes, s.notes) AS spec_notes
         FROM plans pl
         JOIN specs s ON s.id = pl.spec_id
        WHERE pl.id = ?`,
    )
    .get(plan_id);
  if (!planRow) throw new Error(`plan not found: ${plan_id}`);

  const cohorts = listCohortsByPlan(db, plan_id);
  const deps = listDependenciesByPlan(db, plan_id);
  const sorted = toposortCohorts(cohorts, deps, plan_id);

  interface BriefResultRow {
    goal: string;
    decisions_made: string;
    approaches_rejected: string;
    debrief: string | null;
    deviations: string | null;
    pr_url: string | null;
  }

  const cohortBlocks: string[] = [];
  for (const cohort of sorted) {
    const briefRow = db
      .prepare<BriefResultRow, [string]>(
        `SELECT goal, decisions_made, approaches_rejected, debrief, deviations, pr_url
           FROM briefs
          WHERE cohort_id = ? AND status = 'approved'
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(cohort.id);

    const lines: string[] = [`### [${cohort.position}] ${cohort.title} (id: ${cohort.id})`];

    if (!briefRow) {
      lines.push("*(no approved brief found)*");
    } else {
      lines.push(`**Goal:** ${briefRow.goal}\n`);

      const decisions: { decision: string; rationale: string }[] = JSON.parse(briefRow.decisions_made);
      if (decisions.length > 0) {
        lines.push("**Decisions made:**");
        for (const d of decisions) lines.push(`- **${d.decision}**: ${d.rationale}`);
        lines.push("");
      }

      const rejected: { approach: string; reason: string }[] = JSON.parse(briefRow.approaches_rejected);
      if (rejected.length > 0) {
        lines.push("**Approaches rejected:**");
        for (const a of rejected) lines.push(`- **${a.approach}**: ${a.reason}`);
        lines.push("");
      }

      if (briefRow.debrief) {
        lines.push("**Debrief:**");
        lines.push(briefRow.debrief);
        lines.push("");
      }

      if (briefRow.deviations) {
        const deviations: { from: string; actual: string; downstream_impact: string }[] = JSON.parse(briefRow.deviations);
        if (deviations.length > 0) {
          lines.push("**Deviations:**");
          for (const dev of deviations) {
            lines.push(`- from: ${dev.from} | actual: ${dev.actual} | downstream_impact: ${dev.downstream_impact}`);
          }
          lines.push("");
        }
      }

      if (briefRow.pr_url) lines.push(`**PR:** ${briefRow.pr_url}`);
    }

    cohortBlocks.push(lines.join("\n"));
  }

  return {
    PLAN_ID: plan_id,
    PLAN_TITLE: planRow.spec_title,
    SPEC_NOTES: planRow.spec_notes ?? "(no notes)",
    COHORT_RESULTS: cohortBlocks.join("\n\n"),
    KBBL_URL: kbblUrl,
  };
}

// ---- Workdir resolution ----

function resolveWorkdirForSpec(db: Database, spec_id: string): string {
  const project = getProjectForSpec(db, spec_id);
  if (!project) throw new Error(`project not found for spec ${spec_id}`);
  return project.repo_path;
}

function resolveWorkdirForCohort(db: Database, cohort_id: string): string {
  const project = getProjectForCohort(db, cohort_id);
  if (!project) throw new Error(`project not found for cohort ${cohort_id}`);
  return project.repo_path;
}

function resolveWorkdirForBrief(db: Database, brief_id: string): string {
  const project = getProjectForBrief(db, brief_id);
  if (!project) throw new Error(`project not found for brief ${brief_id}`);
  return project.repo_path;
}

function resolveWorkdirForPlan(db: Database, plan_id: string): string {
  const project = getProjectForPlan(db, plan_id);
  if (!project) throw new Error(`project not found for plan ${plan_id}`);
  return project.repo_path;
}

// ---- Public factory ----

export function createDispatcher({ db, backends, kbblUrl }: DispatcherDeps): Dispatcher {
  return {
    async dispatch(stageName: string, inputId: string): Promise<string> {
      const stage = getStage(db, stageName);
      if (!stage) throw new Error(`unknown stage: ${stageName}`);

      const backend = backends[stage.default_backend];
      if (!backend) throw new Error(`no backend registered for '${stage.default_backend}'`);

      const template = loadPrompt(stage.prompt_template_path);

      // Resolve artifact-specific context for the claim and for slot building.
      // We need entity_kind, entity_id, epic_id, and cohort_id (where applicable)
      // before we acquire the dispatch claim.
      let epic: Epic | null = null;
      let claimEntityKind: "spec" | "cohort" | "brief" | "plan";
      let claimCohortId: string | null = null;

      switch (stage.input_artifact_type) {
        case "spec":
          claimEntityKind = "spec";
          epic = resolveEpicForSpec(db, inputId);
          if (!epic) throw new Error(`spec ${inputId}: no epic found`);
          break;
        case "cohort":
          claimEntityKind = "cohort";
          epic = resolveEpicForCohort(db, inputId);
          if (!epic) throw new Error(`cohort ${inputId}: no epic found`);
          claimCohortId = inputId;
          break;
        case "brief": {
          claimEntityKind = "brief";
          const briefCohortRow = db
            .prepare<{ cohort_id: string }, [string]>("SELECT cohort_id FROM briefs WHERE id = ?")
            .get(inputId);
          if (!briefCohortRow) throw new Error(`brief not found: ${inputId}`);
          claimCohortId = briefCohortRow.cohort_id;
          epic = resolveEpicForBrief(db, inputId);
          if (!epic) {
            const identityCtx = getBriefIdentityContext(db, inputId);
            if (identityCtx) epic = getEpicBySpec(db, identityCtx.spec_id);
          }
          if (!epic) throw new Error(`brief ${inputId}: no epic found`);
          break;
        }
        case "plan":
          claimEntityKind = "plan";
          epic = resolveEpicForPlan(db, inputId);
          if (!epic) throw new Error(`plan ${inputId}: no epic found`);
          break;
        default:
          throw new Error(`unsupported input_artifact_type: ${stage.input_artifact_type}`);
      }

      // Lazily close any running attempt whose underlying session has already
      // ended. Without this, a successfully completed session leaves its attempt
      // in status='running' permanently, blocking all future dispatches for the
      // same entity/stage via the active-claim unique index. Boot reconciliation
      // catches the restart case; this catches the normal-completion case.
      const staleActive = getActiveAttempt(db, claimEntityKind, inputId, stage.name);
      if (staleActive?.status === "running" && staleActive.actual_session_ref) {
        const sessionStatus = await backend.status(staleActive.actual_session_ref);
        if (sessionStatus === "completed") {
          markAttemptSucceeded(db, staleActive.id);
        } else if (sessionStatus === "failed") {
          markAttemptFailed(db, staleActive.id, {
            last_error: "session ended with failure status (detected at next dispatch attempt)",
          });
        }
        // If still 'running', leave it — the claim is valid and the session is live.
      }

      // Acquire the dispatch claim before any awaited work. This is the critical
      // section: inserting the attempt record with status='dispatching' makes the
      // claim visible to concurrent callers (hook + POST race, double POST) before
      // any git or session spawn begins. The partial unique index on
      // (entity_kind, entity_id, stage) WHERE status IN ('dispatching','running')
      // makes the claim atomic inside the SQLite transaction.
      const claimResult = claimDispatch(db, {
        id: crypto.randomUUID(),
        entity_kind: claimEntityKind,
        entity_id: inputId,
        stage: stage.name,
        epic_id: epic.id,
        cohort_id: claimCohortId,
      });

      if (!claimResult.claimed) {
        throw new DispatchConflictError(claimResult.active);
      }

      const attempt = claimResult.attempt;
      const attemptSuffix = formatAttemptSuffix(attempt.attempt_number);

      let slots: Record<string, string>;
      let inputRef: InputRef;
      let workdir: string;

      switch (stage.input_artifact_type) {
        case "spec": {
          slots = buildSlotsForSpec(db, inputId, kbblUrl);
          workdir = resolveWorkdirForSpec(db, inputId);
          const sessionName = buildSessionNameForSpec(db, inputId, stage.name);
          inputRef = {
            type: "spec",
            id: inputId,
            workdir,
            sessionName,
            modelSelection: modelSelectionForEpicStage(epic, stage.name),
          };
          break;
        }
        case "cohort": {
          slots = buildSlotsForCohort(db, inputId, kbblUrl);
          workdir = resolveWorkdirForCohort(db, inputId);
          const sessionName = buildSessionNameForCohort(db, inputId, stage.name);
          inputRef = {
            type: "cohort",
            id: inputId,
            workdir,
            sessionName,
            modelSelection: modelSelectionForEpicStage(epic, stage.name),
          };
          break;
        }
        case "brief": {
          slots = buildSlotsForBrief(db, inputId, kbblUrl);
          workdir = resolveWorkdirForBrief(db, inputId);
          const sessionName = buildSessionNameForBrief(db, inputId, stage.name);

          const identityCtx = getBriefIdentityContext(db, inputId);
          if (!identityCtx) throw new Error(`brief ${inputId}: could not resolve cohort/spec chain`);

          const epicSlug = sanitizeForName(epic.title, epic.id);
          const cohortSlug = `${identityCtx.cohort_position}-${sanitizeForName(identityCtx.cohort_title, identityCtx.cohort_id)}`;
          const epicBranch = `epic/${epicSlug}`;
          const branchName = `cohort/${epicSlug}/${cohortSlug}/${attemptSuffix}`;
          const worktreePath = `${epicSlug}/${cohortSlug}/${attemptSuffix}`;

          updateAttemptBranchInfo(db, attempt.id, { branch_name: branchName, worktree_path: worktreePath });

          try {
            await ensureEpicBranchExists(epicBranch, workdir);
          } catch (gitErr) {
            markAttemptFailed(db, attempt.id, {
              last_error: String(gitErr),
              recovery_hint: "Retry dispatch manually via POST /briefs/:id/build.",
            });
            throw gitErr;
          }

          inputRef = {
            type: "brief",
            id: inputId,
            workdir,
            sessionName,
            modelSelection: modelSelectionForEpicStage(epic, stage.name),
            worktreeIdentity: { epicSlug, cohortSlug, epicBranch, attemptSuffix },
          };
          break;
        }
        case "plan": {
          workdir = resolveWorkdirForPlan(db, inputId);
          const sessionName = buildSessionNameForPlan(db, inputId, stage.name);

          if (stage.name === "assessor") {
            const epicSlug = sanitizeForName(epic.title, epic.id);
            const epicBranch = `epic/${epicSlug}`;
            const branchName = `cohort/${epicSlug}/0-assessor/${attemptSuffix}`;
            const worktreePath = `${epicSlug}/0-assessor/${attemptSuffix}`;

            updateAttemptBranchInfo(db, attempt.id, { branch_name: branchName, worktree_path: worktreePath });

            try {
              await requireEpicBranchExists(epicBranch, workdir);
            } catch (gitErr) {
              markAttemptFailed(db, attempt.id, {
                last_error: String(gitErr),
                recovery_hint: "Retry assessor dispatch manually.",
              });
              throw gitErr;
            }

            slots = {
              ...buildSlotsForPlanResults(db, inputId, kbblUrl),
              EPIC_BRANCH: epicBranch,
            };
            inputRef = {
              type: "plan",
              id: inputId,
              workdir,
              sessionName,
              modelSelection: modelSelectionForEpicStage(epic, stage.name),
              worktreeIdentity: { epicSlug, cohortSlug: "0-assessor", epicBranch, attemptSuffix },
            };
          } else {
            slots = buildSlotsForPlan(db, inputId, kbblUrl);
            inputRef = {
              type: "plan",
              id: inputId,
              workdir,
              sessionName,
              modelSelection: modelSelectionForEpicStage(epic, stage.name),
            };
          }
          break;
        }
        default:
          throw new Error(`unsupported input_artifact_type: ${stage.input_artifact_type}`);
      }

      const renderedPrompt = renderPrompt(template, slots);

      let session_ref: string;
      try {
        ({ session_ref } = await backend.dispatch(stage, inputRef, renderedPrompt));
      } catch (spawnErr) {
        markAttemptFailed(db, attempt.id, {
          last_error: String(spawnErr),
          recovery_hint: "Retry dispatch manually.",
        });
        throw spawnErr;
      }

      // Transition the attempt to running now that we have an actual session ref.
      markAttemptRunning(db, attempt.id, session_ref);

      // Persist current_session_ref + current_session_stage on the appropriate
      // artifact. build stage: input is brief, but session_ref lives on the parent cohort.
      switch (stage.input_artifact_type) {
        case "spec":
          db.prepare(
            "UPDATE specs SET current_session_ref = ?, current_session_stage = ? WHERE id = ?",
          ).run(session_ref, stage.name, inputId);
          break;
        case "cohort":
          db.prepare(
            "UPDATE cohorts SET current_session_ref = ?, current_session_stage = ? WHERE id = ?",
          ).run(session_ref, stage.name, inputId);
          break;
        case "brief": {
          const briefRow = db
            .prepare<{ cohort_id: string }, [string]>("SELECT cohort_id FROM briefs WHERE id = ?")
            .get(inputId);
          if (!briefRow) throw new Error(`brief not found when persisting session_ref: ${inputId}`);
          db.prepare(
            "UPDATE cohorts SET current_session_ref = ?, current_session_stage = ? WHERE id = ?",
          ).run(session_ref, stage.name, briefRow.cohort_id);
          break;
        }
        case "plan":
          db.prepare(
            "UPDATE plans SET current_session_ref = ?, current_session_stage = ? WHERE id = ?",
          ).run(session_ref, stage.name, inputId);
          break;
        default:
          throw new Error(`unsupported input_artifact_type: ${stage.input_artifact_type}`);
      }

      return session_ref;
    },
  };
}

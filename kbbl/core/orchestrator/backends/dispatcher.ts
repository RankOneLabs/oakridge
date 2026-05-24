import type { Database } from "bun:sqlite";
import type { ExecutionBackend, InputRef, StageRow } from "./interface";
import { loadPrompt, renderPrompt } from "./prompt-loader";
import { listCohortsByPlan, listDependenciesByPlan } from "../../db/cohorts";
import type { Cohort, CohortDependency } from "../../types/task-tracker";

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
  const spec = db.prepare<SpecRow, [string]>("SELECT id, title, notes FROM specs WHERE id = ?").get(spec_id);
  if (!spec) throw new Error(`spec not found: ${spec_id}`);
  const project = getProjectForSpec(db, spec_id);
  if (!project) throw new Error(`project not found for spec ${spec_id}`);
  return {
    SPEC_ID: spec.id,
    SPEC_TITLE: spec.title,
    SPEC_NOTES: spec.notes ?? "(no notes)",
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

function buildSlotsForBrief(db: Database, brief_id: string, kbblUrl: string): Record<string, string> {
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
      `SELECT pl.spec_id, s.title AS spec_title, s.notes AS spec_notes
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
      `SELECT pl.spec_id, s.title AS spec_title, s.notes AS spec_notes
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

    const lines: string[] = [`### [${cohort.position}] ${cohort.title}`];

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

      let slots: Record<string, string>;
      let inputRef: InputRef;
      let workdir: string;

      switch (stage.input_artifact_type) {
        case "spec": {
          slots = buildSlotsForSpec(db, inputId, kbblUrl);
          workdir = resolveWorkdirForSpec(db, inputId);
          const sessionName = buildSessionNameForSpec(db, inputId, stage.name);
          inputRef = { type: "spec", id: inputId, workdir, sessionName };
          break;
        }
        case "cohort": {
          slots = buildSlotsForCohort(db, inputId, kbblUrl);
          workdir = resolveWorkdirForCohort(db, inputId);
          const sessionName = buildSessionNameForCohort(db, inputId, stage.name);
          inputRef = { type: "cohort", id: inputId, workdir, sessionName };
          break;
        }
        case "brief": {
          slots = buildSlotsForBrief(db, inputId, kbblUrl);
          workdir = resolveWorkdirForBrief(db, inputId);
          const sessionName = buildSessionNameForBrief(db, inputId, stage.name);
          inputRef = { type: "brief", id: inputId, workdir, sessionName };
          break;
        }
        case "plan": {
          slots = stage.name === "planner3"
            ? buildSlotsForPlanResults(db, inputId, kbblUrl)
            : buildSlotsForPlan(db, inputId, kbblUrl);
          workdir = resolveWorkdirForPlan(db, inputId);
          const sessionName = buildSessionNameForPlan(db, inputId, stage.name);
          inputRef = { type: "plan", id: inputId, workdir, sessionName };
          break;
        }
        default:
          throw new Error(`unsupported input_artifact_type: ${stage.input_artifact_type}`);
      }

      const renderedPrompt = renderPrompt(template, slots);
      const { session_ref } = await backend.dispatch(stage, inputRef, renderedPrompt);

      // Persist current_session_ref + current_session_stage on the appropriate
      // artifact. The stage name disambiguates planner2 vs build sessions
      // when the cohort row holds either — without it, the build guard and
      // UI cannot tell a stale planner2 ref apart from a live build.
      // build stage: input is brief, but session_ref lives on the parent cohort.
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

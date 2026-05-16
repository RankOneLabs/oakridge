import type { Database } from "bun:sqlite";
import type { ExecutionBackend, InputRef, StageRow } from "./interface";
import { loadPrompt, renderPrompt } from "./prompt-loader";

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
  return {
    BRIEF_ID: brief_id,
    BRIEF_RENDERED: renderBrief(db, brief_id),
    REPO_PATH: project.repo_path,
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

      if (stage.input_artifact_type === "spec") {
        slots = buildSlotsForSpec(db, inputId, kbblUrl);
        workdir = resolveWorkdirForSpec(db, inputId);
        inputRef = { type: "spec", id: inputId, workdir };
      } else if (stage.input_artifact_type === "cohort") {
        slots = buildSlotsForCohort(db, inputId, kbblUrl);
        workdir = resolveWorkdirForCohort(db, inputId);
        inputRef = { type: "cohort", id: inputId, workdir };
      } else {
        // brief
        slots = buildSlotsForBrief(db, inputId, kbblUrl);
        workdir = resolveWorkdirForBrief(db, inputId);
        inputRef = { type: "brief", id: inputId, workdir };
      }

      const renderedPrompt = renderPrompt(template, slots);
      const { session_ref } = await backend.dispatch(stage, inputRef, renderedPrompt);

      // Persist current_session_ref on the appropriate artifact.
      // build stage: input is brief, but session_ref lives on the parent cohort.
      if (stage.input_artifact_type === "spec") {
        db.prepare("UPDATE specs SET current_session_ref = ? WHERE id = ?").run(session_ref, inputId);
      } else if (stage.input_artifact_type === "cohort") {
        db.prepare("UPDATE cohorts SET current_session_ref = ? WHERE id = ?").run(session_ref, inputId);
      } else {
        // brief → update parent cohort
        const briefRow = db.prepare<{ cohort_id: string }, [string]>("SELECT cohort_id FROM briefs WHERE id = ?").get(inputId);
        if (!briefRow) throw new Error(`brief not found when persisting session_ref: ${inputId}`);
        db.prepare("UPDATE cohorts SET current_session_ref = ? WHERE id = ?").run(session_ref, briefRow.cohort_id);
      }

      return session_ref;
    },
  };
}

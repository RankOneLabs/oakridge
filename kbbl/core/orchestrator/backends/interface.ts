import type { RuntimeModelSelection } from "../../runtime";

export interface StageRow {
  name: string;
  prompt_template_path: string;
  input_artifact_type: "spec" | "cohort" | "brief" | "plan";
  output_artifact_type: "plan" | "brief" | "pr" | "assessment" | "discrepancies";
  gate: "review_required" | "none";
  default_backend: string;
}

/** Cohort/epic identity used for slug-based worktree branch naming. */
export interface EpicIdentity {
  epicSlug: string;
  /** Shape: `<position>-<title-slug>`, e.g. `1-my_feature`. Combined with epicSlug to form `cohort/<epicSlug>/<cohortSlug>`. */
  cohortSlug: string;
  epicBranch: string;
}

export interface InputRef {
  type: "spec" | "cohort" | "brief" | "plan";
  id: string;
  /** Absolute path to the project repo; required by KbblChatBackend to set spawn cwd. */
  workdir: string;
  /**
   * Human-readable session name derived from the stage + artifact, e.g.
   * `planner1_writer` or `builder_cohort_0_writer`. Backends pass this to
   * the underlying session factory so operators can identify dispatched
   * sessions in the list view without clicking in.
   */
  sessionName: string;
  /**
   * Optional cohort/epic identity for build stages. When set, the backend
   * forwards it to SessionManager.create for slug-based worktree branch
   * naming and base-ref selection. Non-build stages leave this undefined
   * and continue with sid-based naming.
   */
  worktreeIdentity?: EpicIdentity;
  /**
   * Explicit runtime/model pair selected by the dispatcher for epic-owned
   * dispatches. Backends route directly with this pair instead of inferring a
   * model from global stage routing.
   */
  modelSelection: RuntimeModelSelection;
}

export interface ExecutionBackend {
  id: string;
  dispatch(stage: StageRow, inputRef: InputRef, renderedPrompt: string): Promise<{ session_ref: string }>;
  status(session_ref: string): Promise<"running" | "completed" | "failed">;
}

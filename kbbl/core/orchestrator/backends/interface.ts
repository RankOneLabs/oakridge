export interface StageRow {
  name: string;
  prompt_template_path: string;
  input_artifact_type: "spec" | "cohort" | "brief";
  output_artifact_type: "plan" | "brief" | "pr";
  gate: "review_required" | "none";
  default_backend: string;
}

export interface InputRef {
  type: "spec" | "cohort" | "brief";
  id: string;
  /** Absolute path to the project repo; required by KbblChatBackend to set spawn cwd. */
  workdir: string;
}

export interface ExecutionBackend {
  id: string;
  dispatch(stage: StageRow, inputRef: InputRef, renderedPrompt: string): Promise<{ session_ref: string }>;
  status(session_ref: string): Promise<"running" | "completed" | "failed">;
}

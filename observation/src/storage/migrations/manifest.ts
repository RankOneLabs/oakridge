export interface MigrationEntry { readonly name: string; readonly file: URL }

const names = [
  "0001_observation.sql", "0002_projection.sql", "0003_revision_links.sql", "0003_grading.sql",
  "0004_cursor.sql", "0005_export.sql", "0006_export_guard.sql", "0007_purge.sql",
  "0008_langfuse_sync.sql", "0009_grade_label_origin.sql",
  "0010_question_text_and_evaluator_instructions.sql", "0011_evaluation_eligibility.sql",
  "0012_grading_job.sql", "0013_human_collection_mode.sql", "0014_annotation_evaluator_v2.sql",
] as const;

export const migrations: readonly MigrationEntry[] = names.map((name) => ({ name, file: new URL(name, import.meta.url) }));
export interface MigrationEntry { readonly name: string; readonly file: URL }


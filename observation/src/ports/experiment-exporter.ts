import type { GradeListingItem } from "../storage/grading-store";

export type ExperimentFormat = "jsonl" | "assay";
export interface ExperimentExporter {
  export(format: ExperimentFormat, observations: readonly GradeListingItem[]): AsyncIterable<string>;
}

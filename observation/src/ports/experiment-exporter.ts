import type { GradeListingItem } from "../grading/observation";

export type ExperimentFormat = "jsonl" | "assay";
export interface ExperimentExporter {
  export(format: ExperimentFormat, observations: readonly GradeListingItem[]): AsyncIterable<string>;
}

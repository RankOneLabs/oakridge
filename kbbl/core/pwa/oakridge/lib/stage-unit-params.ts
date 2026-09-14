import type { StageUnit } from "../types";
import { isBuildBrief, type BuildBrief } from "./build-brief";

/**
 * The build brief behind a stage unit, narrowed from `params.artifact` by
 * `isBuildBrief`. Null for a scalar unit (`params` empty), and for an
 * assessor unit — its `artifact` is a `dev.build_result` body, which the
 * guard rejects on shape. Consumers read this selector; they never
 * re-derive `unit.params.artifact` inline.
 */
export function selectCohortBrief(unit: StageUnit): BuildBrief | null {
  const artifact = unit.params?.artifact;
  return isBuildBrief(artifact) ? artifact : null;
}

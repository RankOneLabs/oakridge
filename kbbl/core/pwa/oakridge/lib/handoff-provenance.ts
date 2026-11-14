import type { OperatorAttemptView, OperatorArtifactRevisionView } from "../operator-contracts/projections/unit-view";
import { parseBuildBrief } from "./build-brief";
export interface HandoffBriefProvenance { revision_id: string | null; build_item_ids: string[] | null }
/** Only the exact recorded input revision can supply item ids. */
export function selectHandoffBrief(attempt: Pick<OperatorAttemptView, "intent"> | null, revisions: readonly Pick<OperatorArtifactRevisionView, "id" | "unit_id" | "body">[]): HandoffBriefProvenance {
  const provenance = attempt?.intent?.input_provenance;
  const reference = provenance?.status === "recorded" ? provenance.entries.find((entry) => entry.input === "brief") : null;
  if (!reference) return { revision_id: null, build_item_ids: null };
  const revision = revisions.find((candidate) => candidate.id === reference.revision_id && candidate.unit_id === reference.unit);
  const brief = revision ? parseBuildBrief(revision.body) : null;
  return { revision_id: reference.revision_id, build_item_ids: brief?.shape === "build_items" ? brief.build_items.map((item) => item.id) : null };
}

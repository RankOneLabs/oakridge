import itemSummary from "./observation-item-summary.json";
import splitLineage from "./observation-split-lineage.json";
import mergeLineage from "./observation-merge-lineage.json";
import disagreement from "./observation-disagreement.json";
import type { ArtifactItemSummary } from "../../../server/observation/view-model";
import type { ObservationLineage, ObservationGradesPage } from "../../../server/observation/client";
import { gradesPageSchema, lineageSchema } from "../../../server/observation/client";
import { z } from "zod";

// JSON fixtures are checked against the same response contracts the PWA reads.
const unresolvedSummarySchema = z.object({ resolution: z.object({ kind: z.literal("unresolved"), revision_id: z.string() }),
  grade: z.object({ tag: z.literal("not_ingested") }), eligibility: z.array(z.object({ tag: z.string(),
    question_id: z.string(), question_version: z.string(), payload: z.unknown() })) });
export const unresolvedSummary: ArtifactItemSummary = unresolvedSummarySchema.parse(itemSummary);
export const splitLineageResponse: ObservationLineage = lineageSchema.parse(splitLineage);
export const mergeLineageResponse: ObservationLineage = lineageSchema.parse(mergeLineage);
export const disagreementResponse: ObservationGradesPage = gradesPageSchema.parse(disagreement);

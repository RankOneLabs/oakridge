import type { ComponentType } from "react";
import { SpecAnalysisViewer } from "./components/molecules/SpecAnalysisViewer";
import { PlanViewer } from "./components/molecules/PlanViewer";
import { BuildBriefViewer } from "./components/molecules/BuildBriefViewer";
import { BuildResultViewer } from "./components/molecules/BuildResultViewer";
import { AssessmentViewer } from "./components/molecules/AssessmentViewer";
import { PrSummaryViewer } from "./components/molecules/PrSummaryViewer";
import { OperatorTypedValue } from "./components/molecules/OperatorTypedValue";

/** v2 bodies are plain JSON, so a viewer needs no pinned schema to read them. */
export interface ViewerProps { readonly body: unknown }

const VIEWERS: Readonly<Record<string, ComponentType<ViewerProps>>> = {
  analysis_body: SpecAnalysisViewer,
  plan_body: PlanViewer,
  brief_body: BuildBriefViewer,
  build_body: BuildResultViewer,
  assessment_body: AssessmentViewer,
  pr_body: PrSummaryViewer,
};

export function resolveViewer(schema: string): ComponentType<ViewerProps> {
  return VIEWERS[schema] ?? OperatorTypedValueViewer;
}

/** The fallback for an artifact with no registered viewer. */
function OperatorTypedValueViewer({ body }: ViewerProps) {
  return <OperatorTypedValue value={body} />;
}

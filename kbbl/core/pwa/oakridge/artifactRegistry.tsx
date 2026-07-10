import type { ComponentType } from "react";
import { SpecAnalysisViewer } from "./viewers/SpecAnalysisViewer";
import { PlanViewer } from "./viewers/PlanViewer";
import { BuildResultViewer } from "./viewers/BuildResultViewer";
import { AssessmentViewer } from "./viewers/AssessmentViewer";
import { PrSummaryViewer } from "./viewers/PrSummaryViewer";

export interface ViewerProps {
  body: unknown;
}

interface RegistryEntry {
  Viewer: ComponentType<ViewerProps>;
}

const REGISTRY: Record<string, RegistryEntry> = {
  "dev-spec-analysis-viewer": { Viewer: SpecAnalysisViewer },
  "dev-plan-viewer": { Viewer: PlanViewer },
  "dev-build-result-viewer": { Viewer: BuildResultViewer },
  "dev-assessment-viewer": { Viewer: AssessmentViewer },
  "dev-pr-summary-viewer": { Viewer: PrSummaryViewer },
};

export function resolveViewer(componentId: string | null | undefined): ComponentType<ViewerProps> | null {
  if (!componentId) return null;
  return REGISTRY[componentId]?.Viewer ?? null;
}

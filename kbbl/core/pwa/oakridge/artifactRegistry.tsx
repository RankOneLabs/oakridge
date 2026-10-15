import type { ComponentType } from "react";
import type { ArtifactReviewDescriptor, ArtifactSource } from "./types";
import { SpecAnalysisViewer } from "./components/molecules/SpecAnalysisViewer";
import { PlanViewer } from "./components/molecules/PlanViewer";
import { BuildResultReview } from "./components/organisms/BuildResultReview";
import { AssessmentReview } from "./components/organisms/AssessmentReview";
import { PrSummaryViewer } from "./components/molecules/PrSummaryViewer";
import { BuildBriefViewer } from "./components/molecules/BuildBriefViewer";

export interface ViewerProps {
  body: unknown;
  descriptor?: ArtifactReviewDescriptor | null;
  source?: ArtifactSource;
  edit?: {
    enabled: boolean;
    isPending: boolean;
    onEdit: (anchor: string, previousValue: unknown, newValue: unknown) => void;
  };
}

interface RegistryEntry {
  Viewer: ComponentType<ViewerProps>;
}

const REGISTRY: Record<string, RegistryEntry> = {
  "dev-spec-analysis-viewer": { Viewer: SpecAnalysisViewer },
  "dev-plan-viewer": { Viewer: PlanViewer },
  "dev-build-brief-viewer": { Viewer: BuildBriefViewer },
  "dev-build-result-viewer": { Viewer: BuildResultReview },
  "dev-assessment-viewer": { Viewer: AssessmentReview },
  "dev-pr-summary-viewer": { Viewer: PrSummaryViewer },
};

export function resolveViewer(componentId: string | null | undefined): ComponentType<ViewerProps> | null {
  if (!componentId) return null;
  return REGISTRY[componentId]?.Viewer ?? null;
}

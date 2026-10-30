import type { ComponentType } from "react";
import type { ArtifactReviewDescriptor, ArtifactSource, ParkedGate } from "./types";
import type { EditOutcome } from "./lib/edit-outcome";
import { SpecViewer } from "./components/molecules/SpecViewer";
import { SpecAnalysisViewer } from "./components/molecules/SpecAnalysisViewer";
import { PlanViewer } from "./components/molecules/PlanViewer";
import { BuildResultReview } from "./components/organisms/BuildResultReview";
import { AssessmentReview } from "./components/organisms/AssessmentReview";
import { PrSummaryViewer } from "./components/molecules/PrSummaryViewer";
import { BuildBriefViewer } from "./components/molecules/BuildBriefViewer";
import { TasksViewer } from "./components/molecules/TasksViewer";

export interface ViewerProps {
  body: unknown;
  descriptor?: ArtifactReviewDescriptor | null;
  source?: ArtifactSource;
  edit?: {
    enabled: boolean;
    isPending: boolean;
    /** Each save settles once it is accepted or refused, so an editor keeps a refused draft. */
    onEdit: (anchor: string, previousValue: unknown, newValue: unknown) => Promise<EditOutcome>;
    onSubmitBody?: (previousBody: unknown, nextBody: unknown) => Promise<EditOutcome>;
  };
  /** The open review of the revision on screen, when it is the latest; a viewer may record a decision on it. */
  gate?: ParkedGate;
}

interface RegistryEntry {
  Viewer: ComponentType<ViewerProps>;
}

const REGISTRY: Record<string, RegistryEntry> = {
  "dev-spec-analysis-viewer": { Viewer: SpecAnalysisViewer },
  "dev-spec-viewer": { Viewer: SpecViewer },
  "dev-plan-viewer": { Viewer: PlanViewer },
  "dev-tasks-viewer": { Viewer: TasksViewer },
  "dev-build-brief-viewer": { Viewer: BuildBriefViewer },
  "dev-build-result-viewer": { Viewer: BuildResultReview },
  "dev-assessment-viewer": { Viewer: AssessmentReview },
  "dev-pr-summary-viewer": { Viewer: PrSummaryViewer },
};

export function resolveViewer(componentId: string | null | undefined): ComponentType<ViewerProps> | null {
  if (!componentId) return null;
  return REGISTRY[componentId]?.Viewer ?? null;
}

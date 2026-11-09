import type { ComponentType, ReactNode } from "react";
import type { ArtifactReviewDescriptor, ArtifactSource, ParkedGate } from "./artifact-types";
import type { EditOutcome } from "./lib/edit-outcome";
import type { ItemSelection } from "./grading-types";
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
  /** Opens the shared item panel. A finding needs only its revision and path: no task, cohort or review. */
  onOpenItem?: (selection: ItemSelection) => void;
  /** Grading controls a stateful parent renders for a viewer's findings; without them a finding offers only Grade. */
  itemGrading?: ItemGradingSlots;
  /** Opens a task by its run-scoped id: navigation only, never an item address. */
  onOpenTask?: (task_id: string) => void;
}

export interface ItemGradingSlots {
  /** One finding's control: its Grade button with the operator's own progress, and its automatic grades when revealed. */
  renderItemAction: (selection: ItemSelection) => ReactNode;
  /** One control over every finding on screen. */
  renderShowAll: (selections: readonly ItemSelection[]) => ReactNode;
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

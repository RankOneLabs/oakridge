import { CurrentSpecAnalysisViewer } from "./components/molecules/CurrentSpecAnalysisViewer";
import { CurrentSpecViewer } from "./components/molecules/CurrentSpecViewer";
import { CurrentPlanViewer } from "./components/molecules/CurrentPlanViewer";
import { CurrentBuildBriefViewer } from "./components/molecules/CurrentBuildBriefViewer";
import { parseCurrentAnalysis, parseCanonicalSpec, parseCurrentPlan, parseCurrentBrief } from "./lib/current-contract";
import { selectAnalysisItemPaths, selectSpecItemPaths, selectPlanItemPaths, selectBriefItemPaths, selectAssessmentItemPaths } from "./lib/current-item-paths";
import { SchemaContractView } from "./components/molecules/SchemaContractView";
import type { Task } from "./lib/tasks";
import { parseAssessment, parseCurrentAssessment } from "./lib/assessment";
import { parsePlan } from "./lib/plan";
import { parseTasks } from "./lib/tasks";
import { readBuildBrief } from "./lib/build-brief";
import { isSpecAnalysis } from "./lib/spec-analysis";
import type { ComponentType, ReactNode } from "react";
import type { ArtifactReviewDescriptor, ArtifactSource, ParkedGate } from "./artifact-types";
import type { EditOutcome } from "./lib/edit-outcome";
import type { ObservationItemAddress } from "./grading-contracts/grading/item-reads";
import { SpecViewer } from "./components/molecules/SpecViewer";
import { SpecAnalysisViewer } from "./components/molecules/SpecAnalysisViewer";
import { PlanViewer } from "./components/molecules/PlanViewer";
import { BuildResultReview } from "./components/organisms/BuildResultReview";
import { AssessmentReview } from "./components/organisms/AssessmentReview";
import { CurrentAssessmentReview } from "./components/organisms/CurrentAssessmentReview";
import { PrSummaryViewer } from "./components/molecules/PrSummaryViewer";
import { BuildBriefViewer } from "./components/molecules/BuildBriefViewer";
import { TasksViewer } from "./components/molecules/TasksViewer";

export interface ViewerProps {
  currentRead?: import("./lib/versioned-body").CurrentArtifactRead;
  context?: import("./lib/current-context").CurrentArtifactContext;
  renderEditableText?: (props: { anchor: string; value: string; edit: NonNullable<ViewerProps["edit"]>; isMultiline: boolean }) => ReactNode;
  renderTaskEditControls?: (props: { task: Task; anchor: string; edit: NonNullable<ViewerProps["edit"]> }) => ReactNode;
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
  onOpenItem?: (selection: ObservationItemAddress) => void;
  /** Grading controls a stateful parent renders for a viewer's findings; without them a finding offers only Grade. */
  itemGrading?: ItemGradingSlots;
  /** Opens a task by its run-scoped id: navigation only, never an item address. */
  onOpenTask?: (task_id: string) => void;
}

export interface ItemGradingSlots {
  /** One finding's control: its Grade button with the operator's own progress, and its automatic grades when revealed. */
  renderItemAction: (selection: ObservationItemAddress) => ReactNode;
  /** One control over every finding on screen. */
  renderShowAll: (selections: readonly ObservationItemAddress[]) => ReactNode;
}

interface RegistryEntry {
  Viewer: ComponentType<ViewerProps>;
}

const REGISTRY: Record<string, RegistryEntry> = {
  "dev-current-analysis-viewer": { Viewer: CurrentSpecAnalysisViewer },
  "dev-current-spec-viewer": { Viewer: CurrentSpecViewer },
  "dev-current-plan-viewer": { Viewer: CurrentPlanViewer },
  "dev-current-brief-viewer": { Viewer: CurrentBuildBriefViewer },

  "dev-spec-analysis-viewer": { Viewer: SpecAnalysisViewer },
  "dev-spec-viewer": { Viewer: SpecViewer },
  "dev-plan-viewer": { Viewer: PlanViewer },
  "dev-tasks-viewer": { Viewer: TasksViewer },
  "dev-build-brief-viewer": { Viewer: BuildBriefViewer },
  "dev-build-result-viewer": { Viewer: BuildResultReview },
  "dev-current-assessment-viewer": { Viewer: CurrentAssessmentReview },
  "dev-assessment-viewer": { Viewer: AssessmentReview },
  "dev-pr-summary-viewer": { Viewer: PrSummaryViewer },
};

export function resolveViewer(componentId: string | null | undefined): ComponentType<ViewerProps> | null {
  if (!componentId) return null;
  return REGISTRY[componentId]?.Viewer ?? null;
}

/** The same contract-defined gradeable collections used by the registered viewers. */
export function selectViewerItemPaths(Viewer: ComponentType<ViewerProps>, body: unknown): readonly string[] {
  if (Viewer === CurrentSpecAnalysisViewer) { const parsed = parseCurrentAnalysis(body); return parsed.ok ? selectAnalysisItemPaths(parsed.value) : []; }
  if (Viewer === CurrentSpecViewer) { const parsed = parseCanonicalSpec(body); return parsed.ok ? selectSpecItemPaths(parsed.value) : []; }
  if (Viewer === CurrentPlanViewer) { const parsed = parseCurrentPlan(body); return parsed.ok ? selectPlanItemPaths(parsed.value) : []; }
  if (Viewer === CurrentBuildBriefViewer) { const parsed = parseCurrentBrief(body); return parsed.ok ? selectBriefItemPaths(parsed.value) : []; }
  if (Viewer === SpecAnalysisViewer && isSpecAnalysis(body)) return body.findings.map((_, index) => `/findings/${index}`);
  if (Viewer === BuildBriefViewer) {
    const brief = readBuildBrief(body);
    return brief ? brief.shape === "legacy" ? brief.acceptance_criteria.map((_, index) => `/acceptance_criteria/${index}`) : brief.build_items.map((_, index) => `/build_items/${index}`) : [];
  }
  if (Viewer === CurrentAssessmentReview) {
    const parsed = parseCurrentAssessment(body);
    return parsed.ok ? selectAssessmentItemPaths(parsed.value) : [];
  }
  if (Viewer === AssessmentReview) {
    const parsed = parseAssessment(body);
    return parsed.ok ? parsed.value.findings.map((finding) => finding.item_path) : [];
  }
  if (Viewer === TasksViewer) {
    const parsed = parseTasks(body);
    return parsed.ok ? parsed.value.tasks.map((_, index) => `/tasks/${index}`) : [];
  }
  if (Viewer === PlanViewer) {
    const parsed = parsePlan(body);
    return parsed.ok ? parsed.value.cohorts.flatMap((cohort, cohortIndex) => cohort.acceptance_criteria.map((_, index) => `/cohorts/${cohortIndex}/acceptance_criteria/${index}`)) : [];
  }
  return [];
}

export interface ContractRendererProps {
  schema: import("./operator-contracts/core-client/core-types").OperatorType;
  schemas: import("./operator-contracts/core-client/core-types").OperatorParsedWorkflow["schemas"];
  definition_id: string;
}
export const CONTRACT_RENDERERS: Partial<Record<import("./operator-contracts/core-client/core-types").OperatorArtifactKind, ComponentType<ContractRendererProps>>> = {};
export function resolveContractRenderer(kind: import("./operator-contracts/core-client/core-types").OperatorArtifactKind): ComponentType<ContractRendererProps> {
  return CONTRACT_RENDERERS[kind] ?? SchemaContractView;
}

export function isReadableViewer(Viewer: ComponentType<ViewerProps>, body: unknown): boolean {
  if (Viewer === SpecAnalysisViewer) return isSpecAnalysis(body);
  if (Viewer === SpecViewer) return typeof body === "string";
  if (Viewer === PlanViewer) return parsePlan(body).ok;
  if (Viewer === TasksViewer) return parseTasks(body).ok;
  if (Viewer === BuildBriefViewer) return readBuildBrief(body) !== null;
  if (Viewer === CurrentAssessmentReview) return parseCurrentAssessment(body).ok;
  if (Viewer === AssessmentReview) return parseAssessment(body).ok;
  return true;
}

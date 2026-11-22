import { indexProjectedSchemas, matchesProjectedSchema } from "./lib/projected-schema";
import type { OperatorSchema } from "./operator-contracts/projections/schema-view";
import { CurrentSpecAnalysisViewer } from "./components/molecules/CurrentSpecAnalysisViewer";
import { CurrentSpecViewer } from "./components/molecules/CurrentSpecViewer";
import { CurrentPlanViewer } from "./components/molecules/CurrentPlanViewer";
import { CurrentBuildBriefViewer } from "./components/molecules/CurrentBuildBriefViewer";
import { parseCurrentAnalysis, parseCanonicalSpec, parseCurrentPlan, parseCurrentBrief } from "./lib/current-contract";
import { selectAnalysisItemPaths, selectSpecItemPaths, selectPlanItemPaths, selectBriefItemPaths } from "./lib/current-item-paths";
import { SchemaContractView } from "./components/molecules/SchemaContractView";
import type { ComponentType, ReactNode } from "react";
import type { ArtifactReviewDescriptor, ArtifactSource, ParkedGate } from "./artifact-types";
import type { EditOutcome } from "./lib/edit-outcome";
import type { ObservationItemAddress } from "./grading-contracts/grading/item-reads";
import { BuildResultReview } from "./components/organisms/BuildResultReview";
import { CurrentAssessmentReview } from "./components/organisms/CurrentAssessmentReview";
import { PrSummaryViewer } from "./components/molecules/PrSummaryViewer";

export interface ViewerProps {
  assessment?: {
    readonly unitId: string;
    readonly artifact: string;
    readonly subject: string | null;
    readonly paths: readonly (readonly import("./operator-contracts/core-client/core-types").OperatorPathSegment[])[];
    readonly workers: readonly import("./operator-contracts/projections/unit-view").OperatorProjectedWorker[];
  };
  context?: import("./lib/current-context").CurrentArtifactContext;
  renderEditableText?: (props: { anchor: string; value: string; edit: NonNullable<ViewerProps["edit"]>; isMultiline: boolean }) => ReactNode;
  body: unknown;
  linkField?: string | null;
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

export const VIEWERS = {
  requirements_analysis: CurrentSpecAnalysisViewer,
  specification: CurrentSpecViewer,
  cohort_plan: CurrentPlanViewer,
  build_brief: CurrentBuildBriefViewer,
  build_result: BuildResultReview,
  assessment: CurrentAssessmentReview,
  pull_request: PrSummaryViewer,
} satisfies Record<string, ComponentType<ViewerProps>>;

export type ViewerKey = keyof typeof VIEWERS;

export function resolveViewer(key: string | null | undefined): ComponentType<ViewerProps> | null {
  return key && Object.hasOwn(VIEWERS, key) ? VIEWERS[key as ViewerKey] : null;
}

interface ViewerSelection {
  readonly view: string | null;
  readonly schema?: string;
  readonly schemas?: readonly OperatorSchema[];
  readonly body: unknown;
}

export function selectArtifactViewer({ view, schema, schemas, body }: ViewerSelection): ComponentType<ViewerProps> | null {
  const Viewer = resolveViewer(view);
  return Viewer && schema && schemas && matchesProjectedSchema(indexProjectedSchemas(schemas), schema, body) ? Viewer : null;
}

/** The same contract-defined gradeable collections used by the registered viewers. */
export function selectViewerItemPaths(Viewer: ComponentType<ViewerProps>, body: unknown): readonly string[] {
  if (Viewer === CurrentSpecAnalysisViewer) { const parsed = parseCurrentAnalysis(body); return parsed.ok ? selectAnalysisItemPaths(parsed.value) : []; }
  if (Viewer === CurrentSpecViewer) { const parsed = parseCanonicalSpec(body); return parsed.ok ? selectSpecItemPaths(parsed.value) : []; }
  if (Viewer === CurrentPlanViewer) { const parsed = parseCurrentPlan(body); return parsed.ok ? selectPlanItemPaths(parsed.value) : []; }
  if (Viewer === CurrentBuildBriefViewer) { const parsed = parseCurrentBrief(body); return parsed.ok ? selectBriefItemPaths(parsed.value) : []; }
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

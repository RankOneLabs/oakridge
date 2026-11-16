import type { PublishedGradingContext } from "../../lib/grading-applicability";
import { selectStageInspectorNavigation, selectStageInspectorIdentity } from "../../lib/stage-inspector-navigation";
import { StageInspectorTabs } from "./StageInspectorTabs";
import { selectEffectiveStageTab, STAGE_TABS } from "../../lib/definition-selection";
import { selectDefinitionOverview, selectDefinitionSelection, type DefinitionOverview as Overview } from "../../lib/definition-overview";
import type { DefinitionSelection } from "../../../lib/hash";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
import { selectStageInspector } from "../../lib/stage-inspector";
import { definitionStageHref, definitionUnitHref } from "../../lib/definition-selection";
import { StageInputsSection } from "./StageInputsSection";
import { StageBindingsSection } from "./StageBindingsSection";
import { StageWorkersSection } from "./StageWorkersSection";
import { StagePromptsSection } from "./StagePromptsSection";
import { StageArtifactsSection } from "./StageArtifactsSection";
import { StageReviewsSection } from "./StageReviewsSection";
import { StageCompletionSection } from "./StageCompletionSection";
import { StageSummarySection } from "./StageSummarySection";
interface StageInspectorProps {
  definition: OperatorDefinitionDetail;
  selection: DefinitionSelection | null;
  anchor?: string;
  grading?: PublishedGradingContext;
}
export function StageInspector({ definition, selection, anchor, grading }: StageInspectorProps) {
  const overview = selectDefinitionOverview(definition);
  const navigation = selectStageInspectorNavigation(definition, selection);
  const model = selectStageInspector(definition, selection);
  const identity = selectStageInspectorIdentity(model);
  const activeTab = selectEffectiveStageTab(selection, anchor, model?.name);
  return (
    <section
      aria-label="Stage inspector"
      className="or-definition-inspector [&_h3]:mb-[.6rem] [&_h3]:text-[1.1rem] [&_h3]:font-bold [&_h4]:mt-[.6rem] [&_h4]:mb-1 [&_h4]:font-[650] [&_dd]:ml-3"
    >
      <aside className="or-definition-navigation max-[1024px]:text-[.9rem] max-[640px]:border max-[640px]:border-[var(--border-muted)] max-[640px]:p-2" aria-label="Stages in authored order">
        {navigation.stages.map(({ stage, units, isSelected }) => (
          <div key={stage.label} className="or-definition-navigation-entry">
            <a href={stage.href} aria-current={stage.isCurrent ? "page" : undefined} className={isSelected ? "font-bold" : undefined}>
              {stage.label}
            </a>
            <ul>
              {units.map(unit => (
                <li key={unit.href}>
                  <a href={unit.href} aria-current={unit.isCurrent ? "page" : undefined}>{unit.label}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {navigation.groups.map(group => <a key={group.href} href={group.href} aria-current={group.isCurrent ? "page" : undefined}>{group.label}</a>)}
      </aside>
      <div className="min-w-0 grid content-start gap-3">
        <div data-testid="or-def-selection">{!model && <DefinitionSelectionDetail overview={overview} selection={selection} />}</div>
        {model && selection && <>
          {identity && <header aria-label="Stage identity">
            <h3>{identity.title}</h3>
            {identity.invokers.length > 0 && <p>Invoked by: {identity.invokers.map(unit => <a className="mr-2" key={unit.href} href={unit.href}>{unit.label}</a>)}</p>}
          </header>}
          <StageInspectorTabs id={definition.definition_id} selection={selection} activeTab={activeTab} />
          <div role="tabpanel" aria-label={STAGE_TABS.find(tab => tab.value === activeTab)?.label}>
            {activeTab === "overview" && <><StageSummarySection model={model} />{selection.kind === "unit" && <DefinitionSelectionDetail overview={overview} selection={selection} />}</>}
            {activeTab === "inputs" && <StageInputsSection model={model} />}
            {activeTab === "bindings" && <StageBindingsSection model={model} />}
            {activeTab === "workers" && <StageWorkersSection model={model} />}
            {activeTab === "prompts" && <StagePromptsSection model={model} />}
            {activeTab === "artifacts" && <StageArtifactsSection model={model} grading={grading} />}
            {activeTab === "reviews" && <StageReviewsSection model={model} />}
            {activeTab === "completion" && <StageCompletionSection model={model} />}
          </div>
        </>}
      </div>
    </section>
  );
}

export function DefinitionSelectionDetail({
  overview,
  selection,
}: { overview: Overview } & { selection: import("../../../lib/hash").DefinitionSelection | null }) {
  const summary = selectDefinitionSelection({ overview, selection });
  if (summary.kind === "none") return <p>Select a stage or unit to inspect its declaration.</p>;
  if (summary.kind === "missing") {
    return summary.selection.kind === "stage" ? (
      <p>Stage {summary.selection.stage} is not in this definition.</p>
    ) : (
      <p>Unit {summary.selection.path} is not in this definition.</p>
    );
  }
  if (summary.kind === "stage") {
    return (
      <>
        <h3>Stage: {summary.stage}</h3>
        <p>Invoked by:</p>
        <ul>
          {summary.callers.map((unit) => (
            <li key={unit.path}>
              <a href={definitionUnitHref(overview.id, unit.path)}>{unit.path}</a>
            </li>
          ))}
        </ul>
      </>
    );
  }
  const { unit } = summary;
  return (
    <>
      <h3>Unit: {unit.path}</h3>
      {unit.has_per_member_after && <p>per-member after</p>}
      {unit.is_group ? (
        <p>
          Choose a child unit · group:{" "}
          {unit.children.map((path) => (
            <a key={path} href={definitionUnitHref(overview.id, path)}>
              {path}{" "}
            </a>
          ))}
        </p>
      ) : (
        unit.stage && (
          <p>
            Stage: <a href={definitionStageHref(overview.id, unit.stage)}>{unit.stage}</a>
          </p>
        )
      )}
      <dl>
        {(
          [
            ["pool", unit.pool],
            ["for_each", unit.for_each],
            ["key", unit.key_expression],
            ["after", unit.after_text],
          ] as const
        ).map(
          ([name, value]) =>
            value !== null && (
              <div key={name}>
                <dt>{name}</dt>
                <dd>
                  <code>{value}</code>
                </dd>
              </div>
            ),
        )}
      </dl>
    </>
  );
}

import { StageInspectorTabs } from "./StageInspectorTabs";
import { selectEffectiveStageTab, STAGE_TABS } from "../../lib/definition-selection";
import { selectDefinitionOverview, selectDefinitionSelection, type DefinitionOverview as Overview } from "../../lib/definition-overview";
import type { DefinitionSelection } from "../../../lib/hash";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
import { selectStageInspector, selectStageNavigation } from "../../lib/stage-inspector";
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
}
export function StageInspector({ definition, selection, anchor }: StageInspectorProps) {
  const overview = selectDefinitionOverview(definition);
  const stages = selectStageNavigation(definition);
  const model = selectStageInspector(definition, selection);
  const activeTab = selectEffectiveStageTab(selection, anchor, model?.name);
  return (
    <section
      aria-label="Stage inspector"
      className="or-definition-inspector [&_h3]:mb-[.6rem] [&_h3]:text-[1.1rem] [&_h3]:font-bold [&_h4]:mt-[.6rem] [&_h4]:mb-1 [&_h4]:font-[650] [&_dd]:ml-3"
    >
      <aside className="or-definition-navigation max-[1024px]:text-[.9rem] max-[640px]:border max-[640px]:border-[var(--border-muted)] max-[640px]:p-2" aria-label="Stages in authored order">
        {stages.map(({ name, units }) => (
          <div key={name} className="or-definition-navigation-entry">
            <a
              href={definitionStageHref(definition.definition_id, name)}
              aria-current={(selection?.kind === "stage" && selection.stage === name) || (selection?.kind === "unit" && units.length === 1 && selection.path === name && units[0]?.path === name) ? "page" : undefined}
              className={model?.name === name ? "font-bold" : undefined}
            >
              {name}
            </a>
            <ul>
              {units.filter(unit => !(units.length === 1 && unit.path === name)).map((unit) => (
                <li key={unit.path}>
                  <a
                    href={definitionUnitHref(definition.definition_id, unit.path)}
                    aria-current={
                      selection?.kind === "unit" && selection.path === unit.path
                        ? "page"
                        : undefined
                    }
                  >
                    {unit.path}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {overview.groups.map((unit) => <a key={unit.path} href={definitionUnitHref(definition.definition_id, unit.path)} aria-current={selection?.kind === "unit" && selection.path === unit.path ? "page" : undefined}>{unit.path} (group)</a>)}
      </aside>
      <div className="min-w-0 grid content-start gap-3">
        <div data-testid="or-def-selection">{!model && <DefinitionSelectionDetail overview={overview} selection={selection} />}</div>
        {model && selection && <>
          <header aria-label="Stage identity">
            <h3>{model.name}{selection.kind === "unit" && selection.path !== model.name ? ` · unit ${selection.path}` : ""}</h3>
            {stages.filter(stage => stage.name === model.name).map(stage => !(stage.units.length === 1 && stage.units[0]?.path === model.name) && <p key={stage.name}>Invoked by: {stage.units.map(unit => <a className="mr-2" key={unit.path} href={definitionUnitHref(definition.definition_id, unit.path)}>{unit.path}</a>)}</p>)}
          </header>
          <StageInspectorTabs id={definition.definition_id} selection={selection} activeTab={activeTab} />
          <div role="tabpanel" aria-label={STAGE_TABS.find(tab => tab.value === activeTab)?.label}>
            {activeTab === "overview" && <><StageSummarySection model={model} />{selection.kind === "unit" && <DefinitionSelectionDetail overview={overview} selection={selection} />}</>}
            {activeTab === "inputs" && <StageInputsSection model={model} />}
            {activeTab === "bindings" && <StageBindingsSection model={model} />}
            {activeTab === "workers" && <StageWorkersSection model={model} />}
            {activeTab === "prompts" && <StagePromptsSection model={model} />}
            {activeTab === "artifacts" && <StageArtifactsSection model={model} />}
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

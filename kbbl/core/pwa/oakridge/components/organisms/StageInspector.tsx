import { selectDefinitionOverview, selectDefinitionSelection, type DefinitionOverview as Overview } from "../../lib/definition-overview";
import type { DefinitionSelection } from "../../../lib/hash";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
import { selectStageInspector, selectStageNavigation } from "../../lib/stage-inspector";
import { definitionStageHref, definitionUnitHref } from "../../lib/definition-selection";
import { StageInputsSection } from "../molecules/StageInputsSection";
import { StageBindingsSection } from "../molecules/StageBindingsSection";
import { StageWorkersSection } from "../molecules/StageWorkersSection";
import { StagePromptsSection } from "../molecules/StagePromptsSection";
import { StageArtifactsSection } from "../molecules/StageArtifactsSection";
import { StageReviewsSection } from "../molecules/StageReviewsSection";
import { StageCompletionSection } from "../molecules/StageCompletionSection";
import { StageSummarySection } from "../molecules/StageSummarySection";
interface StageInspectorProps {
  definition: OperatorDefinitionDetail;
  selection: DefinitionSelection | null;
}
export function StageInspector({ definition, selection }: StageInspectorProps) {
  const overview = selectDefinitionOverview(definition);
  const stages = selectStageNavigation(definition);
  const model = selectStageInspector(definition, selection);
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
              aria-current={selection?.kind === "stage" && selection.stage === name ? "page" : undefined}
              className={model?.name === name ? "font-bold" : undefined}
            >
              {name}
            </a>
            <ul>
              {units.map((unit) => (
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
        <div data-testid="or-def-selection">{(selection?.kind !== "stage" || !model) && <DefinitionSelectionDetail overview={overview} selection={selection} />}</div>
        {model && (
          <>
            <StageSummarySection model={model} />
            <StageInputsSection model={model} />
            <StageBindingsSection model={model} />
            <StageWorkersSection model={model} />
            <StagePromptsSection model={model} />
            <StageArtifactsSection model={model} />
            <StageReviewsSection model={model} />
            <StageCompletionSection model={model} />
          </>
        )}
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

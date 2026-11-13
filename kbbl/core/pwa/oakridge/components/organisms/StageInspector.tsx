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
interface StageInspectorProps {
  definition: OperatorDefinitionDetail;
  selection: DefinitionSelection | null;
}
export function StageInspector({ definition, selection }: StageInspectorProps) {
  const stages = selectStageNavigation(definition);
  const model = selectStageInspector(definition, selection);
  return (
    <section
      aria-label="Stage inspector"
      className="grid gap-5 md:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]"
    >
      <aside className="grid content-start gap-3" aria-label="Stages in authored order">
        {stages.map(({ name, units }) => (
          <div key={name} className="rounded border border-[var(--border-muted)] p-3">
            <a
              href={definitionStageHref(definition.definition_id, name)}
              aria-current={model?.name === name ? "page" : undefined}
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
      </aside>
      <div className="min-w-0 grid content-start gap-3">
        {model && (
          <>
            <h2>Stage: {model.name}</h2>
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

import { selectStageInputUnits, stageSelectionHref, type StageSectionProps } from "../../lib/stage-inspector";
import {
  definitionStageHref,
  definitionUnitHref,
  definitionSchemaElementId,
} from "../../lib/definition-selection";
import type { OperatorType } from "../../operator-contracts/core-client/core-types";
interface StageTypeProps extends StageSectionProps {
  value: OperatorType;
}
export function StageType({ value, model }: StageTypeProps) {
  if (value.kind === "named")
    return (
      <a
        href={`${stageSelectionHref(model)}#${definitionSchemaElementId(value.schema)}`}
      >
        {value.schema}
      </a>
    );
  if (value.kind === "record")
    return (
      <dl>
        {Object.entries(value.fields).map(([key, field]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              <StageType model={model} value={field} />
            </dd>
          </div>
        ))}
      </dl>
    );
  if (value.kind === "optional")
    return (
      <span>
        optional(
        <StageType model={model} value={value.value} />)
      </span>
    );
  if (value.kind === "list")
    return (
      <span>
        list(
        <StageType model={model} value={value.item} />)
      </span>
    );
  if (value.kind === "outcome_of")
    return (
      <a href={definitionStageHref(model.definition.definition_id, value.stage)}>
        outcome_of({value.stage})
      </a>
    );
  if (value.kind === "enum") return <span>enum({value.variants.join(", ")})</span>;
  return <code>{value.kind}</code>;
}
export function StageInputsSection({ model }: StageSectionProps) {
  return (
    <section aria-label="Inputs" className="rounded border border-[var(--border-muted)] p-3">
      <h3>Inputs</h3>
      <StageType model={model} value={model.stage.input} />
      {selectStageInputUnits(model).map((unit) => (
        <div key={unit.path}>
          <h4>
            <a href={definitionUnitHref(model.definition.definition_id, unit.path)}>{unit.path}</a>{" "}
            invokes{" "}
            <a href={definitionStageHref(model.definition.definition_id, model.name)}>
              {model.name}
            </a>
          </h4>
          <dl>
            {Object.entries(
              unit.input ?? {},
            ).map(([field, expression]) => (
              <div key={field}>
                <dt>{`run.units.${unit.path}.input.${field}`}</dt>
                <dd>
                  <code>{expression}</code>
                </dd>
              </div>
            ))}
          </dl>
          {unit.for_each && (
            <p>
              for_each: <code>{unit.for_each}</code>
            </p>
          )}
          {unit.key_expression && (
            <p>
              key: <code>{unit.key_expression}</code>
            </p>
          )}
          {unit.after_text && (
            <p>
              after: <code>{unit.after_text}</code>
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

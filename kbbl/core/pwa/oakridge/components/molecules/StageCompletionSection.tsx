import { stageElementId, type StageSectionProps } from "../../lib/stage-inspector";
import { definitionUnitHref } from "../../lib/definition-selection";
import { LetExpression } from "./LetExpression";
export function StageCompletionSection({ model }: StageSectionProps) {
  return (
    <section aria-label="Completion" className="rounded border border-[var(--border-muted)] p-3">
      <h3>Completion</h3>
      {model.stage.done_when && (
        <p>
          done_when: <LetExpression model={model} expression={model.stage.done_when} />
        </p>
      )}
      {model.wholeOutcomeReaders.length > 0 && (
        <div>
          <h4>Whole-outcome readers</h4>
          <ul>
            {model.wholeOutcomeReaders.map((reader, index) => {
              const binding =
                reader.binding.kind === "input"
                  ? `input.${reader.binding.field}`
                  : reader.binding.kind;
              return (
                <li key={index}>
                  <a href={definitionUnitHref(model.definition.definition_id, reader.downstream)}>
                    {reader.downstream}.{binding}
                  </a>{" "}
                  reads the whole outcome of <code>{reader.upstream}</code>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {model.outcomes.map(({ name, expression, readers }) => (
        <div key={name} id={stageElementId(model.name, "outcome", name)}>
          <h4>outcome.{name}</h4>
          <LetExpression model={model} expression={expression} />
          <h5>Downstream readers</h5>
          <ul>
            {readers.map((reader, index) => {
              const binding =
                reader.binding.kind === "input"
                  ? `input.${reader.binding.field}`
                  : reader.binding.kind;
              return (
                <li key={index}>
                  <a href={definitionUnitHref(model.definition.definition_id, reader.downstream)}>
                    {reader.downstream}.{binding}
                  </a>{" "}
                  reads{" "}
                  <code>
                    {reader.upstream}.outcome
                    {reader.outcome_path.length ? `.${reader.outcome_path.join(".")}` : ""}
                  </code>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

import { stageElementId, type StageSectionProps } from "../../lib/stage-inspector";
import { LetExpression } from "./LetExpression";
export function StageBindingsSection({ model }: StageSectionProps) {
  return (
    <section
      aria-label="Bindings (let)"
      className="rounded border border-[var(--border-muted)] p-3"
    >
      <h3>Bindings (let)</h3>
      <dl>
        {Object.entries(model.stage.let ?? {}).map(([name, expression]) => (
          <div key={name} id={stageElementId(model.name, "let", name)} tabIndex={-1}>
            <dt>{name}</dt>
            <dd>
              <LetExpression model={model} expression={expression} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

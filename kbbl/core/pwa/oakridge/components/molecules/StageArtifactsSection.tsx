import {
  stageElementHref,
  stageElementId,
  type StageSectionProps,
} from "../../lib/stage-inspector";
import { StageType } from "./StageInputsSection";
export function StageArtifactsSection({ model }: StageSectionProps) {
  return (
    <section aria-label="Artifacts" className="rounded border border-[var(--border-muted)] p-3">
      <h3>Artifacts</h3>
      {model.artifacts.map(({ name, artifact, producers, consumers }) => (
        <article
          key={name}
          id={stageElementId({ stage: model.name, kind: "artifact", name: name })}
          tabIndex={-1}
        >
          <h4>
            {name}
            {Boolean(artifact.validate?.length) && " · Validated artifact"}
          </h4>
          <p>kind: {artifact.kind}</p>
          <StageType model={model} value={artifact.schema} />
          <ul>
            {artifact.validate?.map((rule, index) => (
              <li key={index}>
                <code>{rule.check}</code> — {rule.message}
              </li>
            ))}
          </ul>
          <p>
            Produced by:{" "}
            {producers.map((key) => (
              <a
                key={key}
                className="mr-2"
                href={stageElementHref(model, { kind: "worker", name: key })}
              >
                {key}
              </a>
            ))}
          </p>
          <p>
            Consumed by reviews:{" "}
            {consumers.map((key) => (
              <a
                key={key}
                className="mr-2"
                href={stageElementHref(model, { kind: "review", name: key })}
              >
                {key}
              </a>
            ))}
          </p>
        </article>
      ))}
    </section>
  );
}

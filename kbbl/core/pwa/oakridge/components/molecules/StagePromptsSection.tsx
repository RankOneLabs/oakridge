import { stageElementId, type StageSectionProps } from "../../lib/stage-inspector";
export function StagePromptsSection({ model }: StageSectionProps) {
  return (
    <section aria-label="Prompts" className="rounded border border-[var(--border-muted)] p-3">
      <h3>Prompts</h3>
      {model.workers.map(
        ({ key, worker }) =>
          worker.kind === "agent" && (
            <div key={key}>
              <h4>{key}</h4>
              <dl>
                {Object.entries(worker.prompts).map(
                  ([mode, prompt]) =>
                    prompt && (
                      <div key={mode}>
                        <dt>{mode}</dt>
                        <dd>{prompt}</dd>
                      </div>
                    ),
                )}
              </dl>
            </div>
          ),
      )}
      {model.reviews.map(
        ({ key, review }) =>
          review.prompt && (
            <p key={key}>
              {key}: {review.prompt}
            </p>
          ),
      )}
      {model.sources.map(({ kind, name, label, content }) => (
        <details
          key={`${kind}:${name}`}
          id={stageElementId({ stage: model.name, kind, name })}
          tabIndex={-1}
        >
          <summary>{label}</summary>
          <pre>{content}</pre>
        </details>
      ))}
    </section>
  );
}

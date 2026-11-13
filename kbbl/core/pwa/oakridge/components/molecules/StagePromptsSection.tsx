import { stageElementId, type StageSectionProps } from "../../lib/stage-inspector";
export function StagePromptsSection({ model }: StageSectionProps) {
  const authored = model.definition.workflow;
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
      {"workers" in authored &&
        model.workers
          .filter((entry) => entry.source)
          .map(({ key, source }) => (
            <details key={key} id={stageElementId(model.name, "template-worker", source!.template)}>
              <summary>Worker template {source!.template}</summary>
              <pre>{JSON.stringify(authored.workers?.[source!.template], null, 2)}</pre>
            </details>
          ))}
      {"reviews" in authored &&
        model.reviews
          .filter((entry) => entry.source)
          .map(({ key, source }) => (
            <details key={key} id={stageElementId(model.name, "template-review", source!.template)}>
              <summary>Review template {source!.template}</summary>
              <pre>{JSON.stringify(authored.reviews?.[source!.template], null, 2)}</pre>
            </details>
          ))}
      {"decisions" in authored &&
        [
          ...new Set(
            model.reviews.flatMap((entry) =>
              entry.decisions.flatMap((decision) => (decision.source ? [decision.source.set] : [])),
            ),
          ),
        ].map((set) => (
          <details key={set} id={stageElementId(model.name, "decision-set", set)}>
            <summary>Decision set {set}</summary>
            <pre>{JSON.stringify(authored.decisions?.[set], null, 2)}</pre>
          </details>
        ))}
    </section>
  );
}

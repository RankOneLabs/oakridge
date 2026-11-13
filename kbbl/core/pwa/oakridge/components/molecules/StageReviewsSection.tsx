import { stageElementHref, stageElementId, type StageSectionProps } from "../../lib/stage-inspector";
import { LetExpression } from "./LetExpression";
export function StageReviewsSection({ model }: StageSectionProps) {
  return <section aria-label="Reviews" className="rounded border border-[var(--border-muted)] p-3"><h3>Reviews</h3>
    {model.reviews.map(({ key, review, source, decisions }) => <article key={key} id={stageElementId(model.name, "review", key)} tabIndex={-1}>
      <h4>{key}</h4><p>of: <a href={stageElementHref(model, "artifact", review.of)}>{review.of}</a> · by: {review.by}</p>
      {source && <a href={stageElementHref(model, "template-review", source.template)}>from template {source.template}</a>}
      {review.when && <p>{review.by === "engine" ? "Decision condition" : "Awaited-decision window"} · when: <LetExpression model={model} expression={review.when} /></p>}
      <dl>{Object.entries(review.inputs ?? {}).map(([name, expression]) => <div key={name}><dt>inputs.{name}</dt><dd><LetExpression model={model} expression={expression} /></dd></div>)}</dl>
      {review.prompt && <p>prompt: {review.prompt}</p>}
      {decisions.map(({ key, decision, source }) => <div key={key}><h5>{decision.label} ({key})</h5>
        <p>effect: {decision.effect}</p>{decision.on && <p>on: <a href={stageElementHref(model, "artifact", decision.on)}>{decision.on}</a></p>}
        {source && <a href={stageElementHref(model, "decision-set", source.set)}>from decision set {source.set}</a>}
        {decision.feedback && <p>feedback: {decision.feedback}</p>}
        <dl>{Object.entries(decision.fields ?? {}).map(([name, label]) => <div key={name}><dt>{name}</dt><dd>{label}</dd></div>)}</dl>
      </div>)}
    </article>)}
  </section>;
}

import {
  stageElementHref,
  stageElementId,
  type StageSectionProps,
} from "../../lib/stage-inspector";
import { selectWorkerTrigger } from "../../lib/worker-trigger";
import { LetExpression } from "./LetExpression";
export function StageWorkersSection({ model }: StageSectionProps) {
  return (
    <section aria-label="Workers" className="rounded border border-[var(--border-muted)] p-3">
      <h3>Workers</h3>
      {model.workers.map(({ key, worker, source }) => {
        const trigger = selectWorkerTrigger(worker);
        return (
          <article
            key={key}
            className="or-stage-worker"
            id={stageElementId({ stage: model.name, kind: "worker", name: key })}
            tabIndex={-1}
          >
            <h4>{key}</h4>
            <p>
              {worker.kind}
              {worker.kind === "code" && ` · operation: ${worker.operation}`}
            </p>
            {source && (
              <a href={stageElementHref(model, { kind: "template-worker", name: source.template })}>
                from template {source.template}
              </a>
            )}
            {trigger.when && (
              <p>
                when: <LetExpression model={model} expression={trigger.when} />
              </p>
            )}
            {trigger.every && <p>every: {trigger.every}</p>}
            {trigger.evaluates && (
              <p>
                evaluates:{" "}
                <a href={stageElementHref(model, { kind: "artifact", name: trigger.evaluates })}>
                  {trigger.evaluates}
                </a>
              </p>
            )}
            <p>modes: {trigger.modes.join(", ") || "none"}</p>
            {worker.kind === "agent" && <p>session: {worker.session ?? "default"}</p>}
            <p>
              produces:{" "}
              {worker.produces.map((name) => (
                <a
                  key={name}
                  className="mr-2"
                  href={stageElementHref(model, { kind: "artifact", name: name })}
                >
                  {name}
                </a>
              ))}
            </p>
            <dl className="or-stage-bindings">
              {Object.entries(worker.inputs).map(([name, expression]) => (
                <div
                  key={name}
                  id={stageElementId({
                    stage: model.name,
                    kind: "worker-input",
                    name: `${key}.${name}`,
                  })}
                >
                  <dt>
                    <a
                      href={stageElementHref(model, {
                        kind: "worker-input",
                        name: `${key}.${name}`,
                      })}
                    >
                      inputs.{name}
                    </a>
                  </dt>
                  <dd>
                    <LetExpression model={model} expression={expression} />
                  </dd>
                </div>
              ))}
            </dl>

          </article>
        );
      })}
    </section>
  );
}

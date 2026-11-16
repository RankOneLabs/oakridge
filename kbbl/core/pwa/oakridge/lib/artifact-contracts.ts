import type { ArtifactContract, ArtifactConsumer } from "../artifact-types";
import type { StageInspectorModel, StageElementReference } from "./stage-inspector";
import { selectPromptRows } from "./prompt-inspector";

export function selectExpressionIdentifiers(expression: string): string[] {
  const tokens = expression.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][A-Za-z0-9_$-]*)/);
  return [...new Set(tokens.filter((token, index) => /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(token) && !tokens[index - 1]?.trimEnd().endsWith(".")))];
}
export function selectConsumerTarget(consumer: ArtifactConsumer): StageElementReference {
  switch (consumer.kind) {
    case "review_of": case "review_input": return { kind: "review", name: consumer.review };
    case "worker_input": return { kind: "worker-input", name: `${consumer.worker}.${consumer.input}` };
    case "evaluates": return { kind: "worker", name: consumer.worker };
    case "let": case "outcome": return { kind: consumer.kind, name: consumer.name };
  }
}
export function selectArtifactContracts(model: Pick<StageInspectorModel, "stage" | "workers" | "reviews" | "definition">): ArtifactContract[] {
  const rows = selectPromptRows(model);
  return Object.entries(model.stage.artifacts).map(([name, artifact]) => {
    const references = (expression: string) => selectExpressionIdentifiers(expression).includes(name);
    const producers = model.workers.filter(({worker}) => worker.produces.includes(name)).map(({key}) => key);
    const consumers: ArtifactConsumer[] = [
      ...model.reviews.flatMap(({key, review}): ArtifactConsumer[] => [
        ...(review.of === name ? [{kind: "review_of" as const, review: key}] : []),
        ...Object.entries(review.inputs ?? {}).filter(([, expression]) => references(expression)).map(([input]): ArtifactConsumer => ({kind: "review_input", review: key, input})),
      ]),
      ...model.workers.flatMap(({key, worker}): ArtifactConsumer[] => [
        ...Object.entries(worker.inputs).filter(([, expression]) => references(expression)).map(([input]): ArtifactConsumer => ({kind: "worker_input", worker: key, input})),
        ...(worker.kind === "agent" && worker.evaluates === name ? [{kind: "evaluates" as const, worker: key}] : []),
      ]),
      ...Object.entries(model.stage.let ?? {}).filter(([, expression]) => references(expression)).map(([name]): ArtifactConsumer => ({kind: "let", name})),
      ...Object.entries(model.stage.outcome).filter(([, expression]) => references(expression)).map(([name]): ArtifactConsumer => ({kind: "outcome", name})),
    ];
    let schema = artifact.schema;
    const visited = new Set<string>();
    while (schema.kind === "named" && !visited.has(schema.schema)) {
      visited.add(schema.schema);
      const resolved = model.definition.effective_workflow.schemas?.[schema.schema];
      if (!resolved) break;
      schema = resolved;
    }
    return { name, ...artifact, validate: artifact.validate, required_fields: schema.kind === "record" ? Object.entries(schema.fields).filter(([, type]) => type.kind !== "optional").map(([name]) => name) : null, producers, consumers, producer_prompts: rows.filter(row => row.owner.kind === "worker" && producers.includes(row.owner.key)) };
  });
}

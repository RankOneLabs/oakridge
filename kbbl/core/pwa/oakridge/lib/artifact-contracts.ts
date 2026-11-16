import type { ArtifactContract, ArtifactConsumer } from "../artifact-types";
import type { StageInspectorModel, StageElementReference } from "./stage-inspector";
import { selectPromptRows } from "./prompt-inspector";
import { selectExpressionReadsArtifact } from "./definition-dependencies";
import type { OperatorType, OperatorParsedWorkflow } from "../operator-contracts/core-client/core-types";

export interface ExpressionToken {
  text: string;
  is_identifier: boolean;
}

/** Preserve quoted strings and field access while recognizing compiler-style words. */
export function tokenizeExpression(expression: string): ExpressionToken[] {
  const tokens = expression.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][A-Za-z0-9_$-]*)/);
  return tokens.map((text, index) => ({
    text,
    is_identifier: /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(text) && !tokens[index - 1]?.trimEnd().endsWith("."),
  }));
}

export function selectExpressionIdentifiers(expression: string): string[] {
  return [...new Set(tokenizeExpression(expression).filter(token => token.is_identifier).map(token => token.text))];
}
export function selectConsumerTarget(consumer: ArtifactConsumer): StageElementReference {
  switch (consumer.kind) {
    case "review_of": case "review_input": return { kind: "review", name: consumer.review };
    case "worker_input": return { kind: "worker-input", name: `${consumer.worker}.${consumer.input}` };
    case "evaluates": return { kind: "worker", name: consumer.worker };
    case "let": case "outcome": return { kind: consumer.kind, name: consumer.name };
  }
}
/** Resolve named aliases without recursing forever on malformed schema cycles. */
export function selectResolvedContractType(type: OperatorType, schemas: OperatorParsedWorkflow["schemas"]): OperatorType {
  const visited = new Set<string>();
  while (type.kind === "named" && !visited.has(type.schema)) {
    visited.add(type.schema);
    const resolved = schemas?.[type.schema];
    if (!resolved) break;
    type = resolved;
  }
  return type;
}

export function selectArtifactContracts(model: Pick<StageInspectorModel, "stage" | "workers" | "reviews" | "definition">): ArtifactContract[] {
  const rows = selectPromptRows(model);
  return Object.entries(model.stage.artifacts).map(([name, artifact]) => {
    const references = (expression: string) => selectExpressionReadsArtifact({expression, artifact: name, bindings: model.stage.let ?? {}});
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
    const schemas = model.definition.effective_workflow.schemas;
    const schema = selectResolvedContractType(artifact.schema, schemas);
    return { name, ...artifact, validate: artifact.validate, required_fields: schema.kind === "record" ? Object.entries(schema.fields).filter(([, type]) => selectResolvedContractType(type, schemas).kind !== "optional").map(([name]) => name) : null, producers, consumers, producer_prompts: rows.filter(row => row.owner.kind === "worker" && producers.includes(row.owner.key)) };
  });
}

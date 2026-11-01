import { createHash } from "node:crypto";
import { canonicalJson } from "canonical-json";
import type { AuthoredWorkflow } from "../../oakridge-dbos/src/core-client/core-types";

export interface DefinitionContent {
  readonly source: AuthoredWorkflow;
  readonly operations: string;
  readonly prompts: Readonly<{ [path: string]: string }>;
}

export function definitionBytes(content: DefinitionContent): string {
  const encoded = canonicalJson(content);
  if (!encoded.ok) throw new Error(`NonCanonicalJson: ${encoded.error.entity_id}: ${encoded.error.detail}`);
  return encoded.value;
}

export function definitionId(content: DefinitionContent): string {
  return createHash("sha256").update(definitionBytes(content), "utf8").digest("hex");
}

/**
 * Each authored workflow, by the name of the JSON derived from it under
 * `workflow-core/fixtures/bundles/`, and the YAML it is written in.
 */
export const WORKFLOW_SOURCES = {
  "review-loop": "workflow-config/samples/review-loop.yaml",
  "fan-out": "workflow-config/samples/fan-out.yaml",
  development: "workflow-config/development.yaml",
} as const;

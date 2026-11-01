import { createHash } from "node:crypto";
import { canonicalJson, type CanonicalizationError, type Result } from "canonical-json";
import type { AuthoredWorkflow } from "../../oakridge-dbos/src/core-client/core-types";

export interface DefinitionContent {
  readonly source: AuthoredWorkflow;
  readonly operations: string;
  readonly prompts: Readonly<{ [path: string]: string }>;
}

export function definitionBytes(content: DefinitionContent): Result<string, CanonicalizationError> {
  return canonicalJson(content);
}

export function definitionId(content: DefinitionContent): Result<string, CanonicalizationError> {
  const encoded = definitionBytes(content);
  if (!encoded.ok) return encoded;
  return { ok: true, value: createHash("sha256").update(encoded.value, "utf8").digest("hex") };
}

/**
 * Each authored workflow, by the name of the JSON derived from it under
 * `workflow-core/fixtures/bundles/`, and the YAML it is written in.
 */
export const WORKFLOW_SOURCES = {
  "review-loop": "workflow-config/samples/review-loop.yaml",
  "fan-out": "workflow-config/samples/fan-out.yaml",
  "template-override": "workflow-config/samples/template-override.yaml",
  development: "workflow-config/development.yaml",
} as const;

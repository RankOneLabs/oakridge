import type { Schema } from "../../source-contracts";
import { recordSchema } from "../../primitives/schemas";

export const primitivesSchemas: Schema[] = [
  recordSchema("unit", []),
  { key: "text", shape: { kind: "string", min_length: 0, max_length: 400000 } },
  { key: "ident", shape: { kind: "string", min_length: 1, max_length: 256 } },
  { key: "repo_path", shape: { kind: "string", min_length: 1, max_length: 4096 } },
  { key: "flag", shape: { kind: "boolean" } },
  { key: "count", shape: { kind: "integer", min: 0, max: 2147483647 } },
  { key: "revision", shape: { kind: "reference", brand: "artifact_revision" } },
  { key: "texts", shape: { kind: "list", item: "text", max_items: 100 } },
  { key: "ids", shape: { kind: "list", item: "ident", max_items: 100 } },
  { key: "revisions", shape: { kind: "list", item: "revision", max_items: 100 } },
  { key: "optional_text", shape: { kind: "optional", item: "text" } },
  { key: "optional_ident", shape: { kind: "optional", item: "ident" } },
  { key: "optional_revision", shape: { kind: "optional", item: "revision" } },
  { key: "runtime", shape: { kind: "enum", variants: ["claude-code", "codex"] } },
  { key: "severity", shape: { kind: "enum", variants: ["blocking", "warning", "info"] } },
  { key: "verdict", shape: { kind: "enum", variants: ["pass", "pass_with_notes", "fail"] } },
  { key: "criterion_status", shape: { kind: "enum", variants: ["met", "not_met", "partial"] } },
  { key: "optional_criterion_status", shape: { kind: "optional", item: "criterion_status" } },
];

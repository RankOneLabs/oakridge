import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson, type Result } from "canonical-json";
import YAML from "yaml";
import { decodeWorkflowSource } from "../../kbbl/core/pwa/oakridge/workflow-definition-types";
import { bytesIdentity, isIdentity, jsonIdentity, type DefinitionId, type OperationRegistryId } from "./definition-identity";
import { commitDefinition, type OperationRegistry } from "./definition-objects";

function unwrap<Value, Failure>(result: Result<Value, Failure>): Value {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const authored = `workflow: identity_test
schemas: { first: text, second: integer }
input: { title: text, count: integer }
run: { units: { main: { stage: first } }, outcome: {} }
stages:
  first:
    input: {}
    artifacts: {}
    workers:
      writer: { kind: agent, prompts: { initial: write.md }, inputs: {}, creates: [] }
      editor: { kind: agent, prompts: { review: write.md }, inputs: {}, creates: [] }
    outcome: {}
  second: { input: {}, artifacts: {}, workers: {}, outcome: {} }
`;
const operations: OperationRegistry = [{ key: "publish", input_schema: "text", output_schema: "text" }];
interface IdentityInputs { readonly yaml?: string; readonly prompt?: Uint8Array; readonly registry?: OperationRegistry }
function definitionId(inputs: IdentityInputs = {}): DefinitionId {
  const document = YAML.parseDocument(inputs.yaml ?? authored, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors[0].message);
  const source = decodeWorkflowSource(document.toJS());
  if (source === null) throw new Error("invalid test source");
  return unwrap(jsonIdentity<DefinitionId>(commitDefinition({
    source,
    operation_registry_id: unwrap(jsonIdentity<OperationRegistryId>(inputs.registry ?? operations)),
    prompts: { "write.md": bytesIdentity(inputs.prompt ?? Buffer.from("Write.\n")) },
  })));
}

test("identities are unprefixed lowercase SHA-256 over the shared canonical UTF-8 bytes", () => {
  const value = { z: "雪", a: [2, 1] };
  const expected = createHash("sha256").update(unwrap(canonicalJson(value)), "utf8").digest("hex");
  expect<string>(unwrap(jsonIdentity(value))).toBe(expected);
});

test("the identity guard rejects uppercase, prefixes, wrong lengths and nonstrings", () => {
  expect(["a".repeat(64), "A".repeat(64), "0".repeat(63), "g".repeat(64), `canonical-json/v1:${"a".repeat(64)}`, null].map(isIdentity))
    .toEqual([true, false, false, false, false, false]);
});

test("noncanonicalizable JSON returns the shared named failure", () => {
  expect(jsonIdentity({ value: undefined }).ok).toBe(false);
});

test("changing exact prompt bytes changes both PromptId and DefinitionId", () => {
  const lf = Buffer.from("Write.\n");
  const crlf = Buffer.from("Write.\r\n");
  expect([bytesIdentity(lf) !== bytesIdentity(crlf), definitionId({ prompt: lf }) !== definitionId({ prompt: crlf })]).toEqual([true, true]);
});

test("changing operations changes both OperationRegistryId and DefinitionId", () => {
  const changed: OperationRegistry = [{ ...operations[0], output_schema: "integer" }];
  expect([unwrap(jsonIdentity(operations)) !== unwrap(jsonIdentity(changed)), definitionId() !== definitionId({ registry: changed })]).toEqual([true, true]);
});

test("reordering the authored schemas mapping changes DefinitionId", () => {
  expect(definitionId({ yaml: authored.replace("first: text, second: integer", "second: integer, first: text") })).not.toBe(definitionId());
});

test("reordering the authored stages mapping changes DefinitionId", () => {
  const document = YAML.parseDocument(authored, { uniqueKeys: true });
  const stages = document.get("stages");
  if (!YAML.isMap(stages)) throw new Error("missing stages");
  stages.items.reverse();
  expect(definitionId({ yaml: document.toString() })).not.toBe(definitionId());
});

test("reordering a stage's workers mapping preserves DefinitionId", () => {
  const document = YAML.parseDocument(authored, { uniqueKeys: true });
  const workers = document.getIn(["stages", "first", "workers"]);
  if (!YAML.isMap(workers)) throw new Error("missing workers");
  workers.items.reverse();
  expect(definitionId({ yaml: document.toString() })).toBe(definitionId());
});

test("reordering input record fields preserves DefinitionId", () => {
  expect(definitionId({ yaml: authored.replace("title: text, count: integer", "count: integer, title: text") })).toBe(definitionId());
});

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalJson, type Result } from "canonical-json";
import YAML from "yaml";
import { decodeWorkflowSource } from "../../kbbl/core/pwa/oakridge/workflow-definition-types";
import { bytesIdentity, isIdentity, jsonIdentity, type DefinitionId, type OperationRegistryId, type PromptId } from "./definition-identity";
import { commitDefinition, referencedPromptPaths, type AuthoredWorkflow, type CommittedDefinition, type OperationRegistry } from "./definition-objects";
import { resolveDefinition, type DefinitionStoreFailure } from "./definition-store";

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
function authoredSource(yaml = authored): AuthoredWorkflow {
  const document = YAML.parseDocument(yaml, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors[0].message);
  const source = decodeWorkflowSource(document.toJS());
  if (source === null) throw new Error("invalid test source");
  return source;
}
function definitionId(inputs: IdentityInputs = {}): DefinitionId {
  return unwrap(jsonIdentity<DefinitionId>(commitDefinition({
    source: authoredSource(inputs.yaml),
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

const temporary_stores: string[] = [];
afterEach(() => {
  for (const directory of temporary_stores.splice(0)) rmSync(directory, { recursive: true, force: true });
});
interface StoreFixture {
  readonly root: string;
  readonly definition: CommittedDefinition;
  readonly definition_id: DefinitionId;
  readonly prompt_id: PromptId;
}
function writeDefinition(root: string, definition: unknown): DefinitionId {
  const id = unwrap(jsonIdentity<DefinitionId>(definition));
  writeFileSync(resolve(root, "workflows", `${id}.json`), unwrap(canonicalJson(definition)));
  return id;
}
function storeFixture(prompt = Buffer.from("\ufeffWrite.\r\n")): StoreFixture {
  const root = mkdtempSync(resolve(tmpdir(), "oakridge-definitions-"));
  temporary_stores.push(root);
  for (const directory of ["workflows", "prompts", "operations"]) mkdirSync(resolve(root, directory));
  const operation_registry_id = unwrap(jsonIdentity<OperationRegistryId>(operations));
  writeFileSync(resolve(root, "operations", `${operation_registry_id}.json`), unwrap(canonicalJson(operations)));
  const prompt_id = bytesIdentity(prompt);
  writeFileSync(resolve(root, "prompts", `${prompt_id}.md`), prompt);
  const definition = commitDefinition({ source: authoredSource(), prompts: { "write.md": prompt_id }, operation_registry_id });
  return { root, definition, prompt_id, definition_id: writeDefinition(root, definition) };
}
function readFailure<Value>(result: Result<Value, DefinitionStoreFailure>): DefinitionStoreFailure {
  if (result.ok) throw new Error("expected a store failure");
  expect(result.error.detail.length).toBeGreaterThan(0);
  return result.error;
}

test("the reader preserves source, authored names, prompt BOM and CRLF, and pinned operations", () => {
  const fixture = storeFixture();
  expect(unwrap(resolveDefinition(fixture.definition_id, fixture.root))).toEqual({
    definition_id: fixture.definition_id,
    ...fixture.definition,
    prompts: { "write.md": "\ufeffWrite.\r\n" },
    operations,
  });
});

test("a stored workflow with bytes differing from its filename returns HashMismatch", () => {
  const fixture = storeFixture();
  writeFileSync(resolve(fixture.root, "workflows", `${fixture.definition_id}.json`), "{}");
  expect(readFailure(resolveDefinition(fixture.definition_id, fixture.root))).toMatchObject({
    kind: "hash_mismatch", operation: "read_definition", identifier: fixture.definition_id,
  });
});

test("a malformed committed object returns MalformedObject without repair", () => {
  const fixture = storeFixture();
  const id = writeDefinition(fixture.root, { ...fixture.definition, stage_names: ["first", "first"] });
  expect(readFailure(resolveDefinition(id, fixture.root))).toMatchObject({ kind: "malformed_object", operation: "read_definition", identifier: id });
});

test("invalid UTF-8 prompt bytes return InvalidUtf8", () => {
  const fixture = storeFixture(Buffer.from([0xc3, 0x28]));
  expect(readFailure(resolveDefinition(fixture.definition_id, fixture.root))).toMatchObject({
    kind: "invalid_utf8", operation: "read_prompt", identifier: fixture.prompt_id,
  });
});

test("a missing prompt returns MissingPrompt instead of dropping the reference", () => {
  const fixture = storeFixture();
  rmSync(resolve(fixture.root, "prompts", `${fixture.prompt_id}.md`));
  expect(readFailure(resolveDefinition(fixture.definition_id, fixture.root))).toMatchObject({
    kind: "missing_prompt", operation: "read_prompt", identifier: fixture.prompt_id,
  });
});

test("a missing registry returns MissingOperationRegistry without substituting today's registry", () => {
  const fixture = storeFixture();
  rmSync(resolve(fixture.root, "operations", `${fixture.definition.operation_registry_id}.json`));
  expect(readFailure(resolveDefinition(fixture.definition_id, fixture.root))).toMatchObject({
    kind: "missing_operation_registry", operation: "read_operation_registry", identifier: fixture.definition.operation_registry_id,
  });
});

test("a changed prompt returns HashMismatch", () => {
  const fixture = storeFixture();
  writeFileSync(resolve(fixture.root, "prompts", `${fixture.prompt_id}.md`), "changed");
  expect(readFailure(resolveDefinition(fixture.definition_id, fixture.root))).toMatchObject({
    kind: "hash_mismatch", operation: "read_prompt", identifier: fixture.prompt_id,
  });
});

test("a changed registry returns HashMismatch", () => {
  const fixture = storeFixture();
  writeFileSync(resolve(fixture.root, "operations", `${fixture.definition.operation_registry_id}.json`), "[]");
  expect(readFailure(resolveDefinition(fixture.definition_id, fixture.root))).toMatchObject({
    kind: "hash_mismatch", operation: "read_operation_registry", identifier: fixture.definition.operation_registry_id,
  });
});

test("a hash-valid malformed registry returns MalformedObject", () => {
  const fixture = storeFixture();
  const registry = [{ key: "bad", input_schema: 42, output_schema: "text" }];
  const operation_registry_id = unwrap(jsonIdentity<OperationRegistryId>(registry));
  writeFileSync(resolve(fixture.root, "operations", `${operation_registry_id}.json`), unwrap(canonicalJson(registry)));
  const id = writeDefinition(fixture.root, { ...fixture.definition, operation_registry_id });
  expect(readFailure(resolveDefinition(id, fixture.root))).toMatchObject({
    kind: "malformed_object", operation: "read_operation_registry", identifier: operation_registry_id,
  });
});

interface MalformedDefinitionCase { readonly name: string; readonly change: (definition: CommittedDefinition) => unknown }
const malformed_definitions: readonly MalformedDefinitionCase[] = [
  { name: "an invalid authored source", change: (definition) => ({ ...definition, source: { ...definition.source, input: 42 } }) },
  { name: "an omitted prompt reference", change: (definition) => ({ ...definition, prompts: {} }) },
  { name: "an extra prompt reference", change: (definition) => ({ ...definition, prompts: { ...definition.prompts, "extra.md": bytesIdentity(Buffer.from("extra")) } }) },
  { name: "a malformed prompt identity", change: (definition) => ({ ...definition, prompts: { "write.md": "../escape" } }) },
  { name: "a malformed registry identity", change: (definition) => ({ ...definition, operation_registry_id: "A".repeat(64) }) },
  { name: "an unknown top-level property", change: (definition) => ({ ...definition, ignored: true }) },
];
for (const { name, change } of malformed_definitions) {
  test(`the reader rejects ${name}`, () => {
    const fixture = storeFixture();
    const id = writeDefinition(fixture.root, change(fixture.definition));
    expect(readFailure(resolveDefinition(id, fixture.root))).toMatchObject({ kind: "malformed_object", operation: "read_definition", identifier: id });
  });
}

test("the reader rejects hash-valid noncanonical JSON instead of normalizing it", () => {
  const fixture = storeFixture();
  const bytes = Buffer.from(JSON.stringify(fixture.definition, null, 2));
  const id = createHash("sha256").update(bytes).digest("hex") as DefinitionId;
  writeFileSync(resolve(fixture.root, "workflows", `${id}.json`), bytes);
  expect(readFailure(resolveDefinition(id, fixture.root))).toMatchObject({ kind: "malformed_object", operation: "read_definition", identifier: id });
});

test("prompt references include shared workers/reviews and both kinds of template override", () => {
  const source = authoredSource(`${authored}
workers:
  shared: { kind: agent, prompts: { initial: shared.md, revise: revise.md, review: review.md, handoff: handoff.md }, inputs: {}, creates: [] }
reviews:
  shared: { of: draft, by: operator, prompt: shared-review.md, decisions: {} }
`);
  const with_overrides: AuthoredWorkflow = { ...source, stages: {
    ...source.stages,
    overrides: { input: {}, artifacts: {}, outcome: {},
      workers: { templated: { template: "shared", overrides: { prompts: { initial: "worker-override.md" } } } },
      reviews: { templated: { template: "shared", overrides: { prompt: "review-override.md" } } },
    },
  } };
  expect(referencedPromptPaths(with_overrides)).toEqual([
    "handoff.md", "review-override.md", "review.md", "revise.md", "shared-review.md", "shared.md", "worker-override.md", "write.md",
  ]);
});

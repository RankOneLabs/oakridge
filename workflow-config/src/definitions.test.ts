import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { canonicalJson, type Result } from "canonical-json";
import YAML from "yaml";
import { decodeWorkflowSource } from "../../oakridge-dbos/src/core-client/source-types";
import { bytesIdentity, isIdentity, jsonIdentity, type DefinitionId, type OperationRegistryId, type PromptId } from "./definition-identity";
import { commitDefinition, referencedPromptPaths, type AuthoredWorkflow, type CommittedDefinition, type DefinitionOrder, type OperationRegistry } from "./definition-objects";
import { DEFINITION_STORE_ROOT, readLaunchableCatalog, resolveDefinition, resolveLaunchableDefinition, isCommittedDefinition, type DefinitionStoreFailure } from "./definition-store";
import { WORKFLOW_SOURCES } from "./workflow-sources";

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
      writer: { kind: agent, prompts: { initial: write.md }, inputs: {}, produces: [] }
      editor: { kind: agent, prompts: { review: write.md }, inputs: {}, produces: [] }
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
function authoredOrder(yaml = authored): DefinitionOrder {
  const document = YAML.parseDocument(yaml, { uniqueKeys: true });
  const schemas = document.get("schemas");
  const stages = document.get("stages");
  if ((schemas != null && !YAML.isMap(schemas)) || !YAML.isMap(stages)) throw new Error("invalid test mappings");
  return {
    schema_names: schemas?.items.map(({ key }) => String(key)) ?? [],
    stage_names: stages.items.map(({ key }) => String(key)),
  };
}
function definitionId(inputs: IdentityInputs = {}): DefinitionId {
  return unwrap(jsonIdentity<DefinitionId>(commitDefinition({
    source: authoredSource(inputs.yaml),
    operation_registry_id: unwrap(jsonIdentity<OperationRegistryId>(inputs.registry ?? operations)),
    prompts: { "write.md": bytesIdentity(inputs.prompt ?? Buffer.from("Write.\n")) },
  }, authoredOrder(inputs.yaml))));
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
  const definition = commitDefinition({ source: authoredSource(), prompts: { "write.md": prompt_id }, operation_registry_id }, authoredOrder());
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

for (const invalid_json of ["{", `${"[".repeat(300)}null${"]".repeat(300)}`]) {
  test(`the reader returns MalformedObject for ${invalid_json.length === 1 ? "invalid JSON" : "JSON exceeding wire depth"}`, () => {
    const fixture = storeFixture();
    const id = createHash("sha256").update(invalid_json, "utf8").digest("hex") as DefinitionId;
    writeFileSync(resolve(fixture.root, "workflows", `${id}.json`), invalid_json);
    expect(readFailure(resolveDefinition(id, fixture.root))).toMatchObject({ kind: "malformed_object", operation: "read_definition", identifier: id });
  });
}

test("prompt references include shared workers/reviews and both kinds of template override", () => {
  const source = authoredSource(`${authored}
workers:
  shared: { kind: agent, prompts: { initial: shared.md, revise: revise.md, review: review.md, handoff: handoff.md }, inputs: {}, produces: [] }
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

const repository_root = resolve(import.meta.dir, "../..");
for (const [name, path] of Object.entries(WORKFLOW_SOURCES)) {
  test(`${name} resolves all transitive references through the committed launchable catalog`, () => {
    const definition = unwrap(resolveLaunchableDefinition(name));
    const document = YAML.parseDocument(readFileSync(resolve(repository_root, path), "utf8"), { uniqueKeys: true });
    const source = decodeWorkflowSource(document.toJS());
    if (source === null) throw new Error("invalid authored source");
    expect({ source: definition.source, schema_names: definition.schema_names, stage_names: definition.stage_names }).toEqual({
      source, ...authoredOrder(readFileSync(resolve(repository_root, path), "utf8")),
    });
  });
}

test("the catalog contains exactly the authored names and no r5-cohort definition", () => {
  expect(Object.keys(unwrap(readLaunchableCatalog())).sort()).toEqual(Object.keys(WORKFLOW_SOURCES).sort());
});

test("every current authored prompt has a byte-identical stored copy alongside historical prompts", () => {
  const prompt_root = resolve(repository_root, "workflow-config/prompts");
  const expected_ids = readdirSync(prompt_root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const authored_bytes = readFileSync(resolve(entry.parentPath, entry.name));
      const id = bytesIdentity(authored_bytes);
      expect(readFileSync(resolve(DEFINITION_STORE_ROOT, "prompts", `${id}.md`))).toEqual(authored_bytes);
      return `${id}.md`;
    });
  expect(readdirSync(resolve(DEFINITION_STORE_ROOT, "prompts"))).toEqual(expect.arrayContaining([...new Set(expected_ids)]));
});

test("git attributes enforce prompt byte preservation and mark the store generated", () => {
  const attributes = readFileSync(resolve(repository_root, ".gitattributes"), "utf8");
  expect(attributes).toMatch(/^workflow-config\/definitions\/prompts\/\*\* -text$|^\* text=auto eol=lf$/m);
  expect(attributes).toContain("workflow-config/definitions/** linguist-generated=true");
});

function generatorFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), "oakridge-generator-"));
  temporary_stores.push(root);
  for (const path of [
    "workflow-config/src", "workflow-config/prompts", "workflow-config/samples", "workflow-config/development.yaml",
    "workflow-core/fixtures/bundles", "oakridge-dbos/src/operations/registry.ts", "oakridge-dbos/src/effects/provider-catalog.ts",
    "oakridge-dbos/src/core-client/source-types.ts",
  ]) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    cpSync(resolve(repository_root, path), resolve(root, path), { recursive: true });
  }
  mkdirSync(resolve(root, "node_modules"));
  for (const dependency of ["canonical-json", "yaml"]) {
    symlinkSync(realpathSync(resolve(repository_root, "workflow-config/node_modules", dependency)), resolve(root, "node_modules", dependency), "dir");
  }
  return root;
}
function runGenerator(root: string, is_check = false) {
  return Bun.spawnSync({
    cmd: [process.execPath, "workflow-config/src/generate.ts", ...(is_check ? ["--check"] : [])],
    cwd: root,
    // The worker's debugger binding is not available to child processes.
    env: { ...process.env, BUN_INSPECT: undefined },
    stdout: "pipe", stderr: "pipe",
  });
}

test("the committed definition store matches every authored source (generator --check)", () => {
  const check = runGenerator(repository_root, true);
  expect({ code: check.exitCode, errors: check.stderr.toString() }).toEqual({ code: 0, errors: "" });
});
interface StoreSnapshot { readonly [path: string]: Buffer }
function storeSnapshot(root: string): StoreSnapshot {
  const store = resolve(root, "workflow-config/definitions");
  return Object.fromEntries(readdirSync(store, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = resolve(entry.parentPath, entry.name);
      return [path.slice(store.length + 1), readFileSync(path)];
    }));
}

test("two generator runs produce identical store filenames and bytes and preserve every Rust fixture", () => {
  const root = generatorFixture();
  const fixtures = readdirSync(resolve(root, "workflow-core/fixtures/bundles"))
    .map((name) => ({ path: resolve(root, "workflow-core/fixtures/bundles", name), bytes: readFileSync(resolve(root, "workflow-core/fixtures/bundles", name)) }));
  const first = runGenerator(root);
  if (first.exitCode !== 0) throw new Error(first.stderr.toString());
  const snapshot = storeSnapshot(root);
  const second = runGenerator(root);
  if (second.exitCode !== 0) throw new Error(second.stderr.toString());
  expect(storeSnapshot(root)).toEqual(snapshot);
  expect(fixtures.map((fixture) => readFileSync(fixture.path).equals(fixture.bytes))).toEqual(fixtures.map(() => true));
  const check = runGenerator(root, true);
  expect({ code: check.exitCode, errors: check.stderr.toString() }).toEqual({ code: 0, errors: "" });
});

for (const mapping of ["schemas", "stages"] as const) {
  test(`numeric-looking ${mapping} names preserve authored order and change identity when reordered`, () => {
    const root = generatorFixture();
    const path = resolve(root, WORKFLOW_SOURCES["review-loop"]);
    const numeric_names = authored.replace(/\bfirst\b/g, '"2"').replace(/\bsecond\b/g, '"1"')
      .replaceAll("write.md", "review-loop/write.md");
    writeFileSync(path, numeric_names);
    const generated = runGenerator(root);
    if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
    const store = resolve(root, "workflow-config/definitions");
    const previous = unwrap(resolveLaunchableDefinition("review-loop", store));
    expect({ schemas: previous.schema_names, stages: previous.stage_names }).toEqual({
      schemas: ["2", "1"], stages: ["2", "1"],
    });

    const document = YAML.parseDocument(numeric_names, { uniqueKeys: true });
    const names = document.get(mapping);
    if (!YAML.isMap(names)) throw new Error(`missing ${mapping}`);
    names.items.reverse();
    writeFileSync(path, document.toString());
    const regenerated = runGenerator(root);
    if (regenerated.exitCode !== 0) throw new Error(regenerated.stderr.toString());
    const next = unwrap(resolveLaunchableDefinition("review-loop", store));
    expect(mapping === "schemas" ? next.schema_names : next.stage_names).toEqual(["1", "2"]);
    expect(next.definition_id).not.toBe(previous.definition_id);
    expect(runGenerator(root, true).exitCode).toBe(0);
  });
}

for (const directory of ["workflows", "prompts", "operations", "catalog"] as const) {
  test(`--check names a differing ${directory} file and does not write`, () => {
    const root = generatorFixture();
    const generated = runGenerator(root);
    if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
    const store = resolve(root, "workflow-config/definitions");
    const path = directory === "catalog" ? resolve(store, "launchable.json")
      : resolve(store, directory, readdirSync(resolve(store, directory))[0]);
    const changed = Buffer.from("corrupted");
    writeFileSync(path, changed);
    const check = runGenerator(root, true);
    expect(check.exitCode).not.toBe(0);
    expect(check.stderr.toString()).toContain(path);
    expect(readFileSync(path)).toEqual(changed);
  });
}

test("regeneration publishes new identities after an authored prompt byte change", () => {
  const root = generatorFixture();
  const generated = runGenerator(root);
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
  const store = resolve(root, "workflow-config/definitions");
  const previous = unwrap(readLaunchableCatalog(store))["review-loop"];
  const pinned = unwrap(resolveDefinition(previous, store));
  const prompt_path = resolve(root, "workflow-config/prompts/review-loop/write.md");
  writeFileSync(prompt_path, Buffer.concat([readFileSync(prompt_path), Buffer.from("\r\nChanged.\r\n")]));
  expect(runGenerator(root, true).exitCode).not.toBe(0);
  expect(runGenerator(root).exitCode).toBe(0);
  expect(runGenerator(root, true).exitCode).toBe(0);
  const next = unwrap(resolveLaunchableDefinition("review-loop", store));
  expect(next.definition_id).not.toBe(previous);
  expect(next.prompts["review-loop/write.md"]).toBe(readFileSync(prompt_path, "utf8"));
  expect(unwrap(resolveDefinition(previous, store))).toEqual(pinned);
});

test("--check names a missing store file", () => {
  const root = generatorFixture();
  const generated = runGenerator(root);
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
  const path = resolve(root, "workflow-config/definitions/launchable.json");
  rmSync(path);
  const check = runGenerator(root, true);
  expect(check.exitCode).not.toBe(0);
  expect(check.stderr.toString()).toContain(path);
});

interface AuthoringChange { readonly name: string; readonly path: string; readonly change: (source: string) => string }
const historical_changes: readonly AuthoringChange[] = [
  { name: "workflow", path: WORKFLOW_SOURCES["review-loop"],
    change: (source) => source.replace("workflow: review_loop", "workflow: review_loop_updated") },
  { name: "operation registry", path: "oakridge-dbos/src/operations/registry.ts",
    change: (source) => source.replace('key: "repository.prepare"', 'key: "repository.prepare.updated"') },
];
for (const change of historical_changes) {
  test(`regeneration retains pinned definitions and transitive objects after a ${change.name} change`, () => {
    const root = generatorFixture();
    expect(runGenerator(root).exitCode).toBe(0);
    const store = resolve(root, "workflow-config/definitions");
    const previous = unwrap(resolveLaunchableDefinition("review-loop", store));
    const snapshot = storeSnapshot(root);
    const path = resolve(root, change.path);
    writeFileSync(path, change.change(readFileSync(path, "utf8")));
    expect(runGenerator(root).exitCode).toBe(0);
    expect(unwrap(resolveLaunchableDefinition("review-loop", store)).definition_id).not.toBe(previous.definition_id);
    expect(unwrap(resolveDefinition(previous.definition_id, store))).toEqual(previous);
    for (const [path, bytes] of Object.entries(snapshot)) {
      if (path !== "launchable.json") expect(readFileSync(resolve(store, path)).equals(bytes)).toBe(true);
    }
    expect(runGenerator(root, true).exitCode).toBe(0);
  });
}

function retainedDefinitions(store: string): { readonly id: DefinitionId; readonly object: unknown }[] {
  return readdirSync(resolve(store, "workflows")).map((name) => ({ id: name.replace(/\.json$/, "") as DefinitionId,
    object: JSON.parse(readFileSync(resolve(store, "workflows", name), "utf8")) }));
}
interface IncompatibleDefinitionCase {
  readonly name: string;
  readonly change: (definition: CommittedDefinition) => unknown;
}
const incompatible_definitions: readonly IncompatibleDefinitionCase[] = [
  ...["creates", "reviews", "gated_review"].map((field) => ({
    name: `worker ${field}`,
    change: (definition: CommittedDefinition) => ({ ...definition, source: { ...definition.source, stages: {
      ...definition.source.stages, document: { ...definition.source.stages.document,
        workers: { writer: { ...definition.source.stages.document?.workers.writer, [field]: [] } },
      },
    } } }),
  })),
  { name: "missing artifact kind", change: (definition) => ({ ...definition, source: { ...definition.source, stages: {
    ...definition.source.stages, document: { ...definition.source.stages.document,
      artifacts: { draft: { schema: "text" } },
    },
  } } }) },
];
/** An incompatible object under its own hash, as an old store or merge would hold it. */
function plantDiscardedDefinition(store: string, change = incompatible_definitions[0].change): string {
  const launchable = unwrap(readLaunchableCatalog(store))["review-loop"];
  const definition = JSON.parse(readFileSync(resolve(store, "workflows", `${launchable}.json`), "utf8")) as CommittedDefinition;
  const object = change(definition);
  const id = unwrap(jsonIdentity<DefinitionId>(object));
  const path = resolve(store, "workflows", `${id}.json`);
  writeFileSync(path, unwrap(canonicalJson(object)));
  return path;
}

test("generation keeps a launchable definition with an input named like the removed field", () => {
  const root = generatorFixture();
  const source = resolve(root, WORKFLOW_SOURCES["review-loop"]);
  writeFileSync(source, readFileSync(source, "utf8").replace("input: { topic: text }\nrun:", "input: { topic: text, gated_review: text }\nrun:"));
  expect(runGenerator(root).exitCode).toBe(0);
  const resolved = unwrap(resolveLaunchableDefinition("review-loop", resolve(root, "workflow-config/definitions")));
  expect({ input: resolved.source.input, check: runGenerator(root, true).exitCode }).toEqual({ input: { topic: "text", gated_review: "text" }, check: 0 });
});

test("the committed store's complete inventory resolves and carries no discarded field", () => {
  const retained = retainedDefinitions(DEFINITION_STORE_ROOT);
  expect(retained.every(({ object }) => isCommittedDefinition(object))).toBe(true);
  expect(retained.map(({ id }) => unwrap(resolveDefinition(id)).definition_id)).toEqual(retained.map(({ id }) => id));
  expect(retained.map(({ id }) => id)).toEqual(expect.arrayContaining(Object.values(unwrap(readLaunchableCatalog()))));
});

test("the source contract refuses the removed grant", () => {
  const yaml = authored.replace("writer: { kind: agent,", "writer: { kind: agent, gated_review: { kind: unscoped },");
  expect(decodeWorkflowSource(YAML.parse(yaml))).toBeNull();
});

for (const incompatible of incompatible_definitions) {
  test(`--check names retained ${incompatible.name} and generation removes it without rewriting decodable objects`, () => {
    const root = generatorFixture();
    expect(runGenerator(root).exitCode).toBe(0);
    const snapshot = storeSnapshot(root);
    const path = plantDiscardedDefinition(resolve(root, "workflow-config/definitions"), incompatible.change);
    const check = runGenerator(root, true);
    expect({ code: check.exitCode, named: check.stderr.toString().includes(path), kept: existsSync(path) })
      .toEqual({ code: 1, named: true, kept: true });
    expect(runGenerator(root).exitCode).toBe(0);
    expect(storeSnapshot(root)).toEqual(snapshot);
    expect(runGenerator(root, true).exitCode).toBe(0);
  });
}

for (const is_check of [false, true]) {
  test(`${is_check ? "--check" : "generation"} reports an unreadable retained definition without deleting or writing objects`, () => {
    const root = generatorFixture();
    expect(runGenerator(root).exitCode).toBe(0);
    const store = resolve(root, "workflow-config/definitions");
    const definition_id = unwrap(readLaunchableCatalog(store))["review-loop"];
    const path = resolve(store, "workflows", `${definition_id}.json`);
    const snapshot = storeSnapshot(root);
    // Make the unreadable object historical, so it would not be regenerated.
    const source = resolve(root, WORKFLOW_SOURCES["review-loop"]);
    writeFileSync(source, readFileSync(source, "utf8").replace("workflow: review_loop", "workflow: review_loop_updated"));
    chmodSync(path, 0o000);
    try {
      const generated = runGenerator(root, is_check);
      expect({ code: generated.exitCode, named: generated.stderr.toString().includes(path),
        read_error: generated.stderr.toString().includes("EACCES"), kept: existsSync(path) })
        .toEqual({ code: 1, named: true, read_error: true, kept: true });
    } finally {
      if (existsSync(path)) chmodSync(path, 0o644);
    }
    expect(storeSnapshot(root)).toEqual(snapshot);
  });
}

test("development is re-pinned from its base-commit 1c7d8017 definition identity", () => {
  expect(unwrap(readLaunchableCatalog()).development).not.toBe("e9e5d79d30eb6b6077d7c430b479b548b691afe06f2f56955a539aececfa08d9");
});

test("generation after a later authored change stays clean and cannot revive a discarded object", () => {
  const root = generatorFixture();
  expect(runGenerator(root).exitCode).toBe(0);
  const store = resolve(root, "workflow-config/definitions");
  const path = plantDiscardedDefinition(store);
  const source = resolve(root, WORKFLOW_SOURCES["review-loop"]);
  writeFileSync(source, readFileSync(source, "utf8").replace("workflow: review_loop", "workflow: review_loop_updated"));
  expect(runGenerator(root).exitCode).toBe(0);
  expect(runGenerator(root).exitCode).toBe(0);
  expect({ revived: existsSync(path), decodable: retainedDefinitions(store).every(({ object }) => isCommittedDefinition(object)),
    check: runGenerator(root, true).exitCode }).toEqual({ revived: false, decodable: true, check: 0 });
});

test("generation refuses an authored source that declares the removed grant", () => {
  const root = generatorFixture();
  expect(runGenerator(root).exitCode).toBe(0);
  const snapshot = storeSnapshot(root);
  const source = resolve(root, "workflow-config/development.yaml");
  writeFileSync(source, readFileSync(source, "utf8").replace("        kind: agent\n", "        kind: agent\n        gated_review: { kind: unscoped }\n"));
  const generated = runGenerator(root);
  expect({ code: generated.exitCode, invalid: generated.stderr.toString().includes("invalid authored workflow shape") }).toEqual({ code: 1, invalid: true });
  expect(storeSnapshot(root)).toEqual(snapshot);
});

interface AssessmentPromptExample { readonly recommended_next_actions: readonly { readonly text: string; readonly id?: string }[] }
for (const name of ["assess", "assess-revise"]) {
  test(`${name} prompts show action objects and leave generated identities to the server`, () => {
    const definition = unwrap(resolveLaunchableDefinition("development"));
    const prompt = definition.prompts[`development/${name}.md`];
    const example = prompt.match(/```json\n([\s\S]*?)\n```/)?.[1];
    if (!example) throw new Error("assessment prompt has no artifact example");
    const body = JSON.parse(example.replaceAll("<number>", "0")) as AssessmentPromptExample;
    expect(body.recommended_next_actions).toEqual([{ text: "<action>" }]);
    expect(prompt).toContain("Omit its `id`; the server generates it");
  });
}

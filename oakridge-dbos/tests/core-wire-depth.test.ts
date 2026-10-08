import { CORE_MAX_DEPTH } from "../src/core-client/generated-contracts";
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { CoreClient } from "../src/core-client/client";
import type { CheckedValue, DefinitionBundle, Snapshot } from "../src/core-client/generated-contracts";

/**
 * Whatever the compiler accepts at the maximum permitted depth has to cross the wire both ways:
 * requests are read by serde_json (127 nested containers) and responses by the generated schema
 * decoder. These run the real binary through CoreClient, which decodes every response.
 */
const root = resolve(import.meta.dir, "../..");
const binary = resolve(root, "workflow-core/target/debug/workflow-cli");
const minimal: DefinitionBundle = await Bun.file(resolve(root, "workflow-core/fixtures/bundles/minimal.json")).json();

function start(args: readonly string[] = []): CoreClient {
  const started = CoreClient.start({ binary, args, deadlineMs: 20_000, maxPendingRequests: 8 });
  if (!started.ok) throw new Error(started.error.detail.detail);
  return started.value;
}
type Json = Record<string, unknown>;
const hold = (id: string): Json => ({ kind: "wait", id, continuations: ["cancel"], reason: "held", attention: { label: "Held", trigger: "cancel" } });
const literal_true: Json = { kind: "literal", schema: "flag", value: true };
function bundle_with(edit: (source: Json) => void, max_depth = CORE_MAX_DEPTH): DefinitionBundle {
  const source = structuredClone(minimal) as unknown as Json;
  (source.limits as Json).max_depth = max_depth;
  edit(source);
  return source as unknown as DefinitionBundle;
}
const tree_of = (source: Json): Json => ((source.scopes as Json[])[0] as Json).tree as Json;
const set_tree = (source: Json, tree: Json): void => { ((source.scopes as Json[])[0] as Json).tree = tree; };

/** Wrap the tree in `levels` nested `if` nodes: one JSON container per level. */
const nested_ifs = (levels: number) => (source: Json): void => {
  let tree = tree_of(source);
  for (let index = 0; index < levels; index++) tree = { kind: "if", id: `wrap_${index}`, condition: literal_true, then: tree, otherwise: hold(`hold_${index}`) };
  set_tree(source, tree);
};
/** A condition of `levels` nested `all` expressions: two containers per level in the source, more in the checked response. */
const nested_conditions = (levels: number) => (source: Json): void => {
  let condition: Json = literal_true;
  for (let index = 0; index < levels; index++) condition = { kind: "all", items: [condition] };
  set_tree(source, { kind: "if", id: "gate", condition, then: tree_of(source), otherwise: hold("hold") });
};
/** The deepest edit that still compiles under `max_depth`, found by probing upward. */
async function deepest(client: CoreClient, family: (levels: number) => (source: Json) => void): Promise<number> {
  let accepted = -1;
  for (let levels = 0; levels < 100; levels++) {
    const result = await client.request("compile", { bundle: bundle_with(family(levels)) });
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: "domain", detail: { kind: "resource_limit", detail: expect.stringContaining("nesting limit") } });
      return accepted;
    }
  accepted = levels;
  }
  throw new Error("nesting never hit the limit");
}

test("the ceiling is a compile-time contract: one past it is a domain error, not a wire error", async () => {
  // A host that allows more than the ceiling still cannot raise it; the default host refuses with limit_exceeds_host.
  const client = start(["--max-depth", "128"]);
  try {
    expect(await client.request("compile", { bundle: bundle_with(() => {}, CORE_MAX_DEPTH) })).toMatchObject({ ok: true });
    expect(await client.request("compile", { bundle: bundle_with(() => {}, CORE_MAX_DEPTH + 1) }))
      .toMatchObject({ ok: false, error: { kind: "domain", detail: { kind: "resource_limit", detail: expect.stringContaining("exceeds the ceiling") } } });
  } finally { client.close(); }
});

for (const [name, family] of [["nested if", nested_ifs], ["nested all", nested_conditions]] as const) {
  test(`a bundle with the deepest ${name} nesting the compiler accepts round-trips; one level more is a compile error`, async () => {
    const client = start();
    try {
      const levels = await deepest(client, family);
      // The probe only counts a level as accepted when CoreClient decoded the compile response.
      expect(levels).toBeGreaterThanOrEqual(CORE_MAX_DEPTH / 2 - 4);
    } finally { client.close(); }
  });
}

test("a value nested at max_depth round-trips through request and response", async () => {
  const links = CORE_MAX_DEPTH - 1;
  const schemas = [{ key: "leaf", shape: { kind: "boolean" } },
    ...Array.from({ length: links }, (_, level) => ({ key: `link_${level}`,
      shape: { kind: "record", fields: [{ key: "f", schema: level + 1 === links ? "leaf" : `link_${level + 1}`, required: true }], dictionary: null } }))];
  const deep = bundle_with((source) => {
    (source.schemas as Json[]).push(...schemas);
    const scope = (source.scopes as Json[])[0] as Json;
    scope.input_schema = "link_0";
    // The action no longer reads the (large) input; it is still carried in the snapshot.
    (((scope.workers as Json[])[0] as Json).actions as Json[])[0]!.input = { kind: "literal", schema: "unit", value: {} };
  });
  let payload: unknown = true;
  for (let level = 0; level < links; level++) payload = { f: payload };
  const client = start();
  try {
    const validated = await client.request("validate_payload", { bundle: deep, schema: "link_0", payload });
    if (!validated.ok || validated.value.kind !== "validated") throw new Error(JSON.stringify(validated));
    const checked: CheckedValue = validated.value.value;
    const unit: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
    const snapshot: Snapshot = { owner: "instance", scope: deep.root, version: 1, input: checked,
      state: { schema: "position", data: { kind: "variant", variant: "ready", value: unit } },
      trigger: { id: "trigger", key: "begin", payload: unit }, observations: [], timestamp_ms: 42, random_seed: 7 };
    const evaluated = await client.request("evaluate", { bundle: deep, snapshot });
    expect(evaluated).toMatchObject({ ok: true, value: { kind: "evaluated" } });
    // One level more is refused as a domain error by the value check, never a malformed frame.
    let too_deep: unknown = payload;
    too_deep = { f: too_deep };
    expect(await client.request("validate_payload", { bundle: deep, schema: "link_0", payload: too_deep }))
      .toMatchObject({ ok: false, error: { kind: "domain" } });
  } finally { client.close(); }
});

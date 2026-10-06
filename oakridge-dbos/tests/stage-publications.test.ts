import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { DefinitionBundle, ReferenceRoot } from "../src/core-client/generated-contracts";
import { readSnapshot, type AuthoritySnapshot } from "../src/storage/snapshot-reader";
import { stagePublications } from "../src/storage/stage-publications";
import { commitDecision, measureAuthoritySnapshot } from "../src/storage/commit";
import type { OutputPublication } from "../src/storage/commit";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import type { RunId, ScopeId } from "../src/storage/schema-records";
import { runtimeFixture } from "./development-runtime-fixture";
import { withDatabase, unit } from "./effect-fixture";

interface CollectionFixture { readonly bundle: DefinitionBundle; readonly source: AuthoritySnapshot; readonly publications: readonly OutputPublication[] }
async function collectionFixture(db: TransactionalSqlExecutor, roots: readonly ReferenceRoot[], keys: readonly string[]): Promise<CollectionFixture> {
  const minimal: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
  const bundle: DefinitionBundle = { ...minimal, schemas: [...minimal.schemas,
    { key: "collection_member", shape: { kind: "record", fields: [{ key: "key", schema: "text", required: true }], dictionary: null } },
    { key: "collection_revision", shape: { kind: "reference", brand: "artifact_revision" } },
    { key: "collection_revisions", shape: { kind: "list", item: "collection_revision", max_items: 100 } },
    { key: "collection_bodies", shape: { kind: "list", item: "collection_member", max_items: 100 } }],
    scopes: minimal.scopes.map((scope) => ({ ...scope,
      outputs: scope.outputs.map((output) => ({ ...output, schema: "collection_member", collection_key: "key" })),
      commands: scope.commands.map((command) => ({ ...command, targets: command.key === "publish"
        ? roots.filter((root) => root.kind === "output_revisions").map((root) => ({ kind: "reference", root, path: [] })) : command.targets })),
      tree: roots.some((root) => root.kind === "output_collection") ? { kind: "if", id: "read_collection_bodies",
        condition: { kind: "every", source: { kind: "reference", root: bodies_root, path: [] }, predicate: { kind: "literal", schema: "flag", value: true } },
        then: scope.tree, otherwise: { kind: "wait", id: "await_members", reason: "waiting for members", continuations: ["begin", "publish", "cancel"], attention: { label: "Await members", trigger: "publish" } } } : scope.tree })) };
  const f = await runtimeFixture(db, bundle, {});
  try {
    for (const key of ["b", "z"]) {
      const body = await f.checked("collection_member", { key });
      await db.query("INSERT INTO authority.artifact_revision (id,scope_id,output_key,collection_key,body) VALUES ($1,$2,'document',$3,$4)", [`old-${key}`, f.root_scope_id, key, JSON.stringify(body)]);
      await db.query("INSERT INTO authority.output_slot (id,scope_id,output_key,collection_key,current_revision_id) VALUES ($1,$2,'document',$3,$4)", [`slot-${key}`, f.root_scope_id, key, `old-${key}`]);
    }
    const source = await readSnapshot(db, f.root_scope_id, { id: "publish", key: "publish", payload: unit });
    if (!source) throw new Error("snapshot missing");
    const publications = await Promise.all(keys.map(async (key): Promise<OutputPublication> => ({ scope_id: f.root_scope_id,
      output_key: "document", collection_key: key, body: await f.checked("collection_member", { key }), revision_id: `new-${key}`,
      execution_id: null, predecessor_id: key === "z" ? "old-z" : null, expected_slot_version: key === "z" ? 0 : null })));
    return { bundle, source, publications };
  } finally { f.core.close(); }
}
const revisions_root: ReferenceRoot = { kind: "output_revisions", key: "document", schema: "collection_revisions" };
const bodies_root: ReferenceRoot = { kind: "output_collection", key: "document", schema: "collection_bodies" };

test("write-boundary measurement uses the roots sent for a scope with workers, commands, children and a collection", async () => withDatabase(async ({ db }) => {
  const reads: ReferenceRoot[] = [{ kind: "trigger" }, { kind: "result", worker: "builder" },
    { kind: "child", key: "single", export: "summary" }, { kind: "children", key: "batch", export: "summary", schema: "units" },
    { kind: "output_collection", key: "document", schema: "units" }];
  const definition = { schemas: [{ key: "unit", shape: { kind: "record", fields: [], dictionary: null } },
    { key: "units", shape: { kind: "list", item: "unit", max_items: 10 } }],
    scopes: [{ key: "root", commands: [{ key: "begin" }], workers: [{ key: "builder" }], resources: [],
      children: [{ key: "single", scope: "root", imports: ["summary"], collection: null },
        { key: "batch", scope: "root", imports: ["summary"], collection: { template: "batch" } }],
      outputs: [{ key: "document", collection_key: "member" }] }] } as unknown as DefinitionBundle;
  await db.query("INSERT INTO authority.definition_bundle (id,digest,source,checked_program) VALUES ('bundle','digest',$1,$2)",
    [JSON.stringify(definition), JSON.stringify({ digest: "digest", scopes: [{ key: "root", reads }] })]);
  await db.query("INSERT INTO authority.run (id,definition_bundle_id) VALUES ('run','bundle')", []);
  await db.query("INSERT INTO authority.scope_instance (id,run_id,scope_key,input,local_state) VALUES ('owner','run','root',$1,$1)", [JSON.stringify(unit)]);
  for (const [id, key, collection] of [["single-child", "single", null], ["batch-child", "batch", "batch"]])
    await db.query("INSERT INTO authority.scope_instance (id,run_id,parent_id,scope_key,child_key,collection_key,input,local_state) VALUES ($1,'run','owner','root',$2,$3,$4,$4)", [id, key, collection, JSON.stringify(unit)]);
  await db.query("INSERT INTO authority.scope_export (id,run_id,scope_id,export_key,value) VALUES ('export','run','single-child','summary',$1)", [JSON.stringify(unit)]);
  await db.query("INSERT INTO authority.child_collection (id,scope_id,collection_key,members) VALUES ('collection','owner','batch',$1)", [JSON.stringify([{ id: "batch-child", key: "batch-child", depends_on: [] }])]);
  await db.query("INSERT INTO authority.execution (id,scope_id,worker_key,generation,status,result) VALUES ('execution','owner','builder',1,'terminal',$1)", [JSON.stringify(unit)]);
  await db.query("INSERT INTO authority.execution_selection (id,scope_id,worker_key,execution_id,generation) VALUES ('selection','owner','builder','execution',1)", []);
  await db.query("INSERT INTO authority.artifact_revision (id,scope_id,output_key,collection_key,body) VALUES ('revision','owner','document','a',$1)", [JSON.stringify(unit)]);
  await db.query("INSERT INTO authority.output_slot (id,scope_id,output_key,collection_key,current_revision_id) VALUES ('slot','owner','document','a','revision')", []);
  const trigger = { id: "trigger", key: "begin", payload: unit };
  const sent = (await readSnapshot(db, "owner" as ScopeId, trigger))!;
  const measurement = measureAuthoritySnapshot(sent);
  expect(measurement.roots).toEqual(sent.reads);
  const result = await commitDecision(db, { identity: { run_id: "run" as RunId, scope_id: "owner" as ScopeId,
    ingress_id: "trigger", request_digest: "digest" }, read_set: sent.read_set, operator_version: null,
    decision: { kind: "wait", reason: "pause", continuations: [], explanation: { bundle_digest: "digest", node_id: "n",
      owner: "owner", read_set: [], trace: [], trigger_id: "trigger" } }, outputs: [], capacity: [], effects: [] }, sent);
  expect(result.ok && result.value.kind).toBe("Committed");
}));

test("revision-only collection publication preserves current members in key order", async () => withDatabase(async ({ db }) => {
  const f = await collectionFixture(db, [revisions_root], ["a"]);
  expect(f.source.snapshot.observations.some((item) => item.root.kind === "output_collection")).toBe(false);
  const staged = stagePublications(f.bundle, f.source, f.publications);
  expect(staged).toMatchObject({ ok: true, value: { snapshot: { observations: [{ value: { data: { kind: "list", items: [
    { data: { id: "new-a" } }, { data: { id: "old-b" } }, { data: { id: "old-z" } }
  ] } } }] } } });
}));
test("revision-only replacement retains unrelated revisions", async () => withDatabase(async ({ db }) => {
  const f = await collectionFixture(db, [revisions_root], ["z"]);
  const staged = stagePublications(f.bundle, f.source, f.publications);
  expect(staged).toMatchObject({ ok: true, value: { snapshot: { observations: [{ value: { data: { items: [
    { data: { id: "old-b" } }, { data: { id: "new-z" } }
  ] } } }] } } });
}));
test("multiple pending collection members keep body and revision observations aligned", async () => withDatabase(async ({ db }) => {
  const f = await collectionFixture(db, [revisions_root, bodies_root], ["z", "a"]);
  const staged = stagePublications(f.bundle, f.source, f.publications);
  if (!staged.ok) throw new Error(staged.error.detail);
  expect([revisions_root, bodies_root].map((root) => staged.value.snapshot.observations.find((item) => item.root.kind === root.kind))).toMatchObject([
    { root: revisions_root, value: { data: { items: [{ data: { id: "new-a" } }, { data: { id: "old-b" } }, { data: { id: "new-z" } }] } } },
    { root: bodies_root, value: { data: { items: ["a", "b", "z"].map((key) => ({ data: { fields: [{ value: { data: { value: key } } }] } })) } } }
  ]);
}));

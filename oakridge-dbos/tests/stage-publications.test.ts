import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { DefinitionBundle, ReferenceRoot } from "../src/core-client/generated-contracts";
import { readSnapshot, type AuthoritySnapshot } from "../src/storage/snapshot-reader";
import { stagePublications } from "../src/storage/stage-publications";
import type { OutputPublication } from "../src/storage/commit";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
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

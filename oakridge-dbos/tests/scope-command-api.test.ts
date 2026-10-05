import { expect, test } from "bun:test";
import type { DefinitionBundle, DecisionOutcome, ReferenceRoot, VersionedValue } from "../src/core-client/generated-contracts";
import { availableCommand, currentTargetRevisions, MalformedRequestError, parseScopeCommand, targetsMatch } from "../src/http/scope-commands";
import type { ScopeId } from "../src/storage/schema-records";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";

const scope_id = "scope-1" as ScopeId;
const state = { schema: "state", data: { kind: "variant" as const, variant: "review", value: { schema: "unit", data: { kind: "boolean" as const, value: true } } } };
const command = { key: "new_bundle_command", payload_schema: "payload", available_in: ["review"], required: true, targets: [], label: "Review", consequence: "Approve", field_presentation: [] };
const bundle = { scopes: [{ key: "scope", commands: [command] }] } as unknown as DefinitionBundle;

test("new pinned command is selected without a server registry", () => {
  expect(availableCommand(bundle, "scope", state, "new_bundle_command")?.label).toBe("Review");
});
test("a command needs identity, version, payload, and exact target list", () => {
  const parsed = parseScopeCommand({ command_key: "new_bundle_command", request_id: "request", scope_id,
    expected_scope_version: 4, payload: {}, targets: [] }, scope_id);
  expect(parsed instanceof MalformedRequestError).toBe(false);
  expect(parseScopeCommand({ command_key: "new_bundle_command", request_id: "request", scope_id,
    payload: {}, targets: [] }, scope_id)).toBeInstanceOf(MalformedRequestError);
});
test("target revision must match the evaluated target and witness", () => {
  const root = { kind: "output" as const, key: "specimen" };
  const targeted = { ...command, targets: [{ kind: "reference" as const, root, path: [] }] };
  const target = { schema: "text", data: { kind: "string" as const, value: "content" } };
  const outcome = { kind: "apply", targets: [target] } as DecisionOutcome;
  const current = [{ identity: "revision-1", version: 3 }];
  expect(targetsMatch(targeted, outcome, [{ identity: "revision-1", version: 3 }], current)).toBe(true);
  expect(targetsMatch(targeted, outcome, [{ identity: "revision-1", version: 2 }], current)).toBe(false);
});
test("output target resolves to its revision and snapshot slot version", async () => {
  const targeted = { ...command, targets: [{ kind: "reference" as const, root: { kind: "output" as const, key: "specimen" }, path: [] }] };
  const db = { query: async () => [{ id: "slot", current_revision_id: "revision-1", version: 3 }] } as unknown as TransactionalSqlExecutor;
  const observations = [{ identity: "slot", version: 3, root: { kind: "output" as const, key: "specimen" }, value: { schema: "text", data: { kind: "string" as const, value: "text" } } }];
  expect(await currentTargetRevisions(db, scope_id, targeted, observations)).toEqual([{ identity: "revision-1", version: 3 }]);
  expect(await currentTargetRevisions(db, scope_id, targeted, [{ ...observations[0]!, version: 2 }])).toEqual([]);
});

test("resource targets match despite PostgreSQL jsonb property ordering", async () => {
  const root: ReferenceRoot = { key: "source", kind: "resource" };
  const targeted = { ...command, targets: [{ kind: "reference" as const, root, path: [] }] };
  const observations: VersionedValue[] = [{ identity: "resource-1", version: 4, root: { kind: "resource", key: "source" }, value: state }];
  const db = { query: async () => [] } as unknown as TransactionalSqlExecutor;
  expect(await currentTargetRevisions(db, scope_id, targeted, observations)).toEqual([{ identity: "resource-1", version: 4 }]);
});
test("child targets match despite PostgreSQL jsonb property ordering", async () => {
  const root: ReferenceRoot = { key: "item", kind: "child", export: "released" };
  const targeted = { ...command, targets: [{ kind: "reference" as const, root, path: [] }] };
  const observations: VersionedValue[] = [{ identity: "export-1", version: 5, root: { kind: "child", key: "item", export: "released" }, value: state }];
  const db = { query: async () => [] } as unknown as TransactionalSqlExecutor;
  expect(await currentTargetRevisions(db, scope_id, targeted, observations)).toEqual([{ identity: "export-1", version: 5 }]);
});
test("child target matching still distinguishes export identities", async () => {
  const root: ReferenceRoot = { key: "item", kind: "child", export: "released" };
  const targeted = { ...command, targets: [{ kind: "reference" as const, root, path: [] }] };
  const observations: VersionedValue[] = [{ identity: "export-1", version: 5, root: { kind: "child", key: "item", export: "private" }, value: state }];
  const db = { query: async () => [] } as unknown as TransactionalSqlExecutor;
  expect(await currentTargetRevisions(db, scope_id, targeted, observations)).toEqual([]);
});

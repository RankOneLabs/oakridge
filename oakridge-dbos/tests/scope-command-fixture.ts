import { Hono } from "hono";
import { resolve } from "node:path";
import type { CoreClient } from "../src/core-client/client";
import type { CheckedValue, DefinitionBundle, DecisionOutcome, Output } from "../src/core-client/generated-contracts";
import { transportFailure, type CoreResult } from "../src/core-client/transport-errors";
import { installDefinitionApi } from "../src/http/app";
import { createMutationService } from "../src/storage/mutation-service";
import type { IngressReceiptRecord, RunId, ScopeId, ScopeInstanceRecord } from "../src/storage/schema-records";
import type { SqlExecutor, TransactionalSqlExecutor } from "../src/storage/sql-executor";
import type { ScopeCommandRequest } from "../src/http/scope-commands";

const run_id = "run-1" as RunId;
const scope_id = "scope-1" as ScopeId;
export const unit: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };
const revision: CheckedValue = { schema: "revision", data: { kind: "reference", brand: "artifact_revision", id: "revision-1" } };
interface HarnessOptions { readonly transport_failure?: boolean; readonly malformed_core?: boolean; readonly missing_scope?: boolean; readonly database_failure?: boolean; readonly change_target_before_commit?: boolean; readonly operator_workspace?: boolean }

export async function harness(options: HarnessOptions = {}) {
  const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/exact-review-target.json")).json();
  if (options.operator_workspace) {
    bundle.schemas.push({ key: "feedback", shape: { kind: "record", fields: [{ key: "text", schema: "text", required: true }], dictionary: null } });
    bundle.scopes[0] = { ...bundle.scopes[0]!, commands: ["discuss", "change"].map((key) => ({ key, label: key, consequence: key,
      payload_schema: "feedback", available_in: ["inspection"], required: true,
      targets: [{ kind: "reference", root: { kind: "result", worker: "potter" }, path: [] }],
      field_presentation: [{ key: "text", presentation: { label: "Feedback", viewer: null } }] })) };
  }
  let owner: ScopeInstanceRecord = { id: scope_id, version: 4, run_id, parent_id: null, scope_key: bundle.root, child_key: null,
    input: unit, local_state: { schema: "phase", data: { kind: "variant", variant: "inspection", value: unit } }, outcome: null, is_terminal: false };
  let slot_version = 3;
  let receipt: IngressReceiptRecord | null = null;
  let evaluate_count = 0;
  let committed_payload: CheckedValue | null = null;
  const artifact = { id: "revision-1", version: "2", scope_id, execution_id: null, output_key: "specimen", collection_key: null,
    predecessor_id: null, body: { schema: "unregistered_output", data: { kind: "string", value: "Output artifact body" } } };
  const db: TransactionalSqlExecutor = {
    async query<Row extends object>(sql: string, parameters: readonly unknown[]): Promise<readonly Row[]> {
      if (options.database_failure) throw new Error("database unavailable");
      let rows: readonly object[] = [];
      if (sql.startsWith("SELECT * FROM authority.ingress_receipt")) rows = receipt ? [receipt] : [];
      else if (sql === "SELECT * FROM authority.scope_instance WHERE id=$1") rows = options.missing_scope ? [] : [owner];
      else if (sql === "SELECT * FROM authority.run WHERE id=$1") rows = [{ id: run_id, version: 1, definition_bundle_id: "bundle-1" }];
      else if (sql === "SELECT * FROM authority.scope_instance WHERE run_id=$1 ORDER BY id") rows = [owner];
      else if (sql.startsWith("SELECT source,digest") || sql.startsWith("SELECT b.id AS bundle_id")) rows = [{ source: bundle, digest: "pinned", bundle_id: "bundle-1" }];
      else if (sql.startsWith("SELECT b.source")) rows = [{ source: bundle, checked_program: { scopes: [{ key: bundle.root, reads: [{ kind: "result", worker: "potter" }, { kind: "output", key: "specimen" }] }] } }];
      else if (sql.startsWith("SELECT id, version FROM authority.scope_instance")) rows = [{ id: scope_id, version: owner.version }];
      else if (sql.startsWith("SELECT e.id, e.version FROM authority.output_slot")) rows = [{ id: "slot-1", version: slot_version }];
      else if (sql.startsWith("SELECT s.*, r.body")) rows = [{ id: "slot-1", output_key: "specimen", body: revision, version: slot_version }];
      else if (sql.startsWith("SELECT s.*, row_to_json")) rows = [{ id: "slot-1", scope_id, output_key: "specimen", collection_key: "", current_revision_id: "revision-1", version: String(slot_version), current_revision: artifact }];
      else if (sql.startsWith("SELECT e.* FROM authority.execution")) rows = [{ id: "exec-1", worker_key: "potter", result: revision, version: 6 }];
      else if (sql.startsWith("SELECT id,current_revision_id,version")) rows = [{ id: "slot-1", current_revision_id: "revision-1", version: slot_version }];
      else if (sql.startsWith("UPDATE authority.scope_instance SET version")) owner = { ...owner, version: owner.version + 1 };
      else if (sql === "SELECT version FROM authority.scope_instance WHERE id=$1") rows = [{ version: owner.version }];
      else if (sql.startsWith("INSERT INTO authority.fact")) committed_payload = JSON.parse(String(parameters[3]));
      else if (sql.startsWith("INSERT INTO authority.ingress_receipt")) receipt = { id: String(parameters[0]), version: 0, run_id, scope_id,
        ingress_id: String(parameters[3]), request_digest: String(parameters[4]), result: JSON.parse(String(parameters[5])) };
      return rows as readonly Row[];
    },
    async transaction<Value>(operation: (tx: SqlExecutor) => Promise<Value>): Promise<Value> {
      // Change a dependency after HTTP target validation but before commit read-set validation.
      if (options.change_target_before_commit && evaluate_count > 0) slot_version++;
      return operation(this);
    },
  };
  const decision: DecisionOutcome = { kind: "apply", targets: [revision], mutations: [], invocations: [], outcome: null,
    explanation: { bundle_digest: "pinned", node_id: "finish_inspection", owner: scope_id, read_set: [], trace: [], trigger_id: "request-1" } };
  const core = {
    async request(operation: string): Promise<CoreResult<Output>> {
      if (options.transport_failure) return transportFailure("unresponsive_child", "deadline exceeded");
      if (options.malformed_core) return { ok: true, value: { kind: "evaluated", value: decision } };
      if (operation === "validate_payload") return { ok: true, value: { kind: "validated", value: unit } };
      evaluate_count++;
      return { ok: true, value: { kind: "evaluated", value: decision } };
    },
  } as unknown as CoreClient;
  const app = new Hono();
  installDefinitionApi(app, { db, core, mutations: createMutationService(db, core), wake: async () => {} });
  const request: ScopeCommandRequest = { command_key: "certify", payload: { specimen: "revision-1" }, request_id: "request-1", scope_id,
    expected_scope_version: 4, targets: [{ identity: "revision-1", version: 3 }] };
  return {
    app,
    request,
    submit: (body: unknown = request) => app.request(`/api/runs/${run_id}/scopes/${scope_id}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    terminate: () => { owner = { ...owner, is_terminal: true, version: owner.version + 1 }; },
    evaluationCount: () => evaluate_count,
    committedPayload: () => committed_payload,
  };
}

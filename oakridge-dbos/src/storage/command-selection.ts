export { availableCommand } from "../projections/scope-view";
import type { CheckedValue, CommandDefinition, DecisionOutcome, DefinitionBundle, VersionedValue } from "../core-client/generated-contracts";
import { plainValue } from "../core-client/plain-value";
import type { JsonValue } from "../domain/primitives";
import type { ScopeId } from "./schema-records";
import type { SqlExecutor } from "./sql-executor";
import { requestDigest } from "./receipts";

export interface TargetRevision { readonly identity: string; readonly version: number }
export interface CurrentOutputRevision {
  readonly id: string;
  readonly slot_version: number;
  readonly revision_id: string;
  readonly body: CheckedValue;
}

/** The current artifact witness for an edit, read from the authority's output slot. */
export async function currentOutputRevision(db: SqlExecutor, scope_id: ScopeId, output_key: string, collection_key: string): Promise<CurrentOutputRevision | null> {
  const rows = await db.query<{ id: string; version: string | number; current_revision_id: string; body: CheckedValue }>(
    `SELECT s.id,s.version,s.current_revision_id,r.body FROM authority.output_slot s
      JOIN authority.artifact_revision r ON r.id=s.current_revision_id AND r.scope_id=s.scope_id
      WHERE s.scope_id=$1 AND s.output_key=$2 AND s.collection_key=$3`, [scope_id, output_key, collection_key]);
  const row = rows[0];
  return row ? { id: row.id, slot_version: Number(row.version), revision_id: row.current_revision_id, body: row.body } : null;
}

export function targetsMatch(command: CommandDefinition, outcome: DecisionOutcome, submitted: readonly TargetRevision[], current: readonly TargetRevision[]): boolean {
  return outcome.kind === "apply" && outcome.targets.length === command.targets.length && submitted.length === current.length
    && current.length === command.targets.length && current.every((target, index) => target.identity === submitted[index]?.identity && target.version === submitted[index]?.version);
}

export async function currentTargetRevisions(db: SqlExecutor, scope_id: ScopeId, command: CommandDefinition, observations: readonly VersionedValue[]): Promise<readonly TargetRevision[]> {
  const targets: TargetRevision[] = [];
  for (const expression of command.targets) {
    if (expression.kind !== "reference") return [];
    if (expression.root.kind === "output") {
      const output_key = expression.root.key;
      const slots = await db.query<{ id: string; current_revision_id: string | null; version: string | number }>(
        "SELECT id,current_revision_id,version FROM authority.output_slot WHERE scope_id=$1 AND output_key=$2 AND collection_key=''", [scope_id, output_key]);
      const slot = slots[0];
      if (!slot?.current_revision_id) return [];
      const observed = observations.find((item) => item.identity === slot.id && item.root.kind === "output" && item.root.key === output_key);
      if (!observed || observed.version !== Number(slot.version)) return [];
      targets.push({ identity: slot.current_revision_id, version: Number(slot.version) });
      continue;
    }
    const observed = observations.find((item) => requestDigest(item.root) === requestDigest(expression.root));
    if (!observed) return [];
    targets.push({ identity: observed.identity, version: observed.version });
  }
  return targets;
}

/** Payload fields a command reads from current evidence, keyed by field. */
export type CommandPrefill = Readonly<{ readonly [field_key: string]: JsonValue }>;

function present(value: CheckedValue): CheckedValue | null {
  if (value.data.kind !== "optional") return value;
  return value.data.value ? present(value.data.value) : null;
}
function recordField(value: CheckedValue, key: string, bundle: DefinitionBundle): CheckedValue | null {
  const record = present(value);
  if (record?.data.kind !== "record") return null;
  const shape = bundle.schemas.find((schema) => schema.key === record.schema)?.shape;
  if (shape?.kind !== "record") return null;
  const field_id = shape.fields.findIndex((field) => field.key === key);
  return record.data.fields.find((field) => field.field_id === field_id)?.value ?? null;
}

/**
 * Prefilled fields resolve from the observations the decision reads, so the
 * submitted payload carries exactly the evidence the operator was shown. A
 * value that is not currently observed is left out for the operator to supply.
 */
export function currentPrefill(bundle: DefinitionBundle, command: CommandDefinition, observations: readonly VersionedValue[]): CommandPrefill {
  const payload = bundle.schemas.find((schema) => schema.key === command.payload_schema)?.shape;
  if (payload?.kind !== "record") return {};
  const prefill: { [field_key: string]: JsonValue } = {};
  for (const entry of command.prefill ?? []) {
    if (entry.value.kind !== "reference") continue;
    const { root, path } = entry.value;
    const observed = observations.find((item) => requestDigest(item.root) === requestDigest(root));
    let value: CheckedValue | null = observed?.value ?? null;
    for (const key of path) value = value ? recordField(value, key, bundle) : null;
    const field_schema = payload.fields.find((field) => field.key === entry.key)?.schema;
    if (value && value.schema !== field_schema) value = present(value);
    if (!value || value.schema !== field_schema) continue;
    const plain = plainValue(value, bundle);
    if (plain.ok) prefill[entry.key] = plain.value;
  }
  return prefill;
}

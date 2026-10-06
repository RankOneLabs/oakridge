export { availableCommand } from "../projections/scope-view";
import type { CommandDefinition, DecisionOutcome, VersionedValue } from "../core-client/generated-contracts";
import type { ScopeId } from "./schema-records";
import type { SqlExecutor } from "./sql-executor";
import { requestDigest } from "./receipts";

export interface TargetRevision { readonly identity: string; readonly version: number }

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

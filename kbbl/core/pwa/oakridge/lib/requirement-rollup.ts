import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { artifactSchemaVersion, selectVersionedComponent } from "./artifact-version";
import { parseCanonicalSpec } from "./current-contract";
import { parseTasks, type Task } from "./tasks";
export interface RunIdentityRollup { readonly label: "Tasks" | "Requirements"; readonly rows: readonly Task[] }
export function selectRunIdentityRollup(units: readonly OperatorUnitView[]): RunIdentityRollup {
  const artifacts = units.flatMap((unit) => unit.artifacts.map((artifact) => ({ unit, artifact })));
  const current = artifacts.find(({ artifact }) => artifact.schema === "spec_body"
    && selectVersionedComponent({ schema: artifact.schema, version: artifactSchemaVersion(artifact.latest_revision) }) !== null);
  if (current) {
    const revision = current.artifact.latest_revision;
    const decision = current.unit.recorded_decisions.filter((entry) => entry.target_revision_id === revision?.id).at(-1);
    const spec = parseCanonicalSpec(decision?.effect === "approve" ? revision?.body : null);
    return { label: "Requirements", rows: spec.ok ? spec.value.requirements.map((requirement) => ({ id: requirement.id, description: requirement.text, requirement_ids: [requirement.id] })) : [] };
  }
  const legacy = artifacts.find(({ artifact }) => artifact.schema === "tasks_body");
  const tasks = parseTasks(legacy?.artifact.latest_revision?.body);
  return { label: "Tasks", rows: tasks.ok ? tasks.value.tasks : [] };
}

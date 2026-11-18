import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { artifactSchemaVersion } from "./artifact-version";
import { cohortSchema, parseCurrent } from "./current-contract";
import { selectReceivedContext } from "./received-context";
import { parseVersionedBody } from "./versioned-body";

/** Writer assignments and implementation cohorts are pinned unit inputs. Artifact
 * bodies are read only after their projected version selects the current contract. */
export function selectUnitRequirementIds(unit: OperatorUnitView): readonly string[] | undefined {
  const assignment = selectReceivedContext(unit);
  if (assignment) return assignment.assignment.cohort.allocations.map((entry) => entry.requirement_id);
  const input = unit.input;
  if (input && typeof input === "object" && !Array.isArray(input) && "cohort" in input) {
    const cohort = parseCurrent(cohortSchema, input.cohort, "parse_gate_cohort");
    if (cohort.ok) return cohort.value.allocations.map((entry) => entry.requirement_id);
  }
  const ids = unit.artifacts.flatMap((artifact): readonly string[] => {
    const revision = artifact.latest_revision;
    if (!revision) return [];
    const parsed = parseVersionedBody({ schema: artifact.schema, version: artifactSchemaVersion(revision), body: revision.body });
    if (!parsed.ok || !parsed.value) return [];
    switch (parsed.value.kind) {
      case "analysis": case "spec": return parsed.value.body.requirements.map((requirement) => requirement.id);
      case "plan": return parsed.value.body.cohorts.flatMap((cohort) => cohort.allocations.map((entry) => entry.requirement_id));
      case "assessment": return parsed.value.body.item_assessments.flatMap(item => item.subject.kind === "requirement" ? [item.subject.id] : []);
      case "brief": return parsed.value.body.build_items.flatMap((entry) => entry.requirement_ids);
    }
  });
  return ids.length ? [...new Set(ids)] : undefined;
}

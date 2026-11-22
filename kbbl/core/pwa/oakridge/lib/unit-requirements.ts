import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { cohortSchema, parseCurrent } from "./current-contract";
import { selectReceivedContext } from "./received-context";


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
  return undefined;
}

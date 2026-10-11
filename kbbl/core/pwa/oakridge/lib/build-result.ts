import type { OperatorCheckedValue, OperatorSchema } from "../operator-contracts";
import { selectFieldItems, selectFieldText } from "../artifact-types";

const issuePriority = (issue: OperatorCheckedValue, schemas: readonly OperatorSchema[]): number => {
  const severity = selectFieldText(issue, schemas, "severity");
  return severity === "blocking" ? 0 : severity === "warning" ? 1 : severity === "info" ? 2 : 3;
};

/** Keep the builder's issue wording while presenting the most urgent issue first. */
export function selectOrderedCheckedIssues(body: OperatorCheckedValue, schemas: readonly OperatorSchema[]): readonly OperatorCheckedValue[] {
  return selectFieldItems(body, schemas, "known_issues").toSorted((left, right) => issuePriority(left, schemas) - issuePriority(right, schemas));
}

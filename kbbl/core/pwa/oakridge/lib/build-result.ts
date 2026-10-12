import { selectFieldItems, selectFieldText } from "../artifact-types";

const issuePriority = (issue: unknown): number => {
  const severity = selectFieldText(issue, "severity");
  return severity === "blocking" ? 0 : severity === "warning" ? 1 : severity === "info" ? 2 : 3;
};

/** Keep the builder's issue wording while presenting the most urgent issue first. */
export function selectOrderedCheckedIssues(body: unknown): readonly unknown[] {
  return selectFieldItems(body, "known_issues").toSorted((left, right) => issuePriority(left) - issuePriority(right));
}

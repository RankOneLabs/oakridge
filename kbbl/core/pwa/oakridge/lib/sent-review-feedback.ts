/** What the operator asked for, in the same words the decision's success message used. */
export function selectSentFeedbackTitle(decision: string): string {
  if (decision === "request_assessment_changes") return "Assessment changes requested";
  if (decision === "request_build_changes") return "Build changes requested";
  return "Changes requested";
}

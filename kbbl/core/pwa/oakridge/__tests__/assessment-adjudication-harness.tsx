import { AssessmentActionsPanel } from "../components/organisms/AssessmentActionsPanel";
import { AssessmentDecisionBar } from "../components/organisms/AssessmentDecisionBar";
import { useAssessmentAdjudication, type AssessmentAdjudicationInput } from "../hooks/useAssessmentAdjudication";

/** The decision bar and actions list over one shared adjudication, as CurrentAssessmentReview composes them. */
export function AdjudicationHarness(props: AssessmentAdjudicationInput) {
  const adjudication = useAssessmentAdjudication(props);
  return <><AssessmentDecisionBar adjudication={adjudication} /><AssessmentActionsPanel assessment={props.assessment} adjudication={adjudication} /></>;
}

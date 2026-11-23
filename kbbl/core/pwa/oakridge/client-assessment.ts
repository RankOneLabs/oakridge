import { oakridgeGet, oakridgePost, unitPath } from "./client-http";
import type { OperatorAssessmentRead } from "./operator-contracts/projections/assessment-status";
import type { OperatorAuthorizeFeedbackRequest, OperatorCreateFeedbackRequest, OperatorDecideAssessmentRequest } from "./operator-contracts/http/ingress";

export interface AssessmentAddress {
  readonly run: string;
  readonly unit: string;
  readonly artifact: string;
}

const assessmentPath = (address: AssessmentAddress): string =>
  `${unitPath(address.run, address.unit)}/assessments/${encodeURIComponent(address.artifact)}`;

export const readAssessmentStatus = (address: AssessmentAddress): Promise<OperatorAssessmentRead> =>
  oakridgeGet(`${assessmentPath(address)}/status`);

export const decideAssessment = (address: AssessmentAddress, review: string, command: OperatorDecideAssessmentRequest) =>
  oakridgePost(`${unitPath(address.run, address.unit)}/reviews/${encodeURIComponent(review)}/decide`, command);

export const createAssessmentFeedback = (address: AssessmentAddress, command: OperatorCreateFeedbackRequest) =>
  oakridgePost(`${assessmentPath(address)}/feedback`, command);

export const authorizeAssessmentFeedback = (address: AssessmentAddress, command: OperatorAuthorizeFeedbackRequest) =>
  oakridgePost(`${unitPath(address.run, address.unit)}/feedback/${encodeURIComponent(command.item)}/authorizations`, command);

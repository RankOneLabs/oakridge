import { expect, test } from "bun:test";
import type { AssignmentRound, DispatchAuthorization, FeedbackItem } from "../src/core-client/core-types";
import { authorizeDispatch, selectAuthorizationId, type DispatchCheck } from "../src/domain/dispatch-policy";
import { renderRoundDelivery } from "../src/domain/round-delivery";
import { selectAssessmentStatus, selectRoundProgress } from "../src/projections/assessment-status";
import type { AssessmentFacts } from "../src/storage/assessment-facts";
import { selectDeliveryKey } from "../src/effects/delivery-key";
import type { EffectInstruction } from "../src/domain/effect-instruction";

const item: FeedbackItem = { id: "item", unit: "unit", assessment_artifact: "assessment", origin: { kind: "operator", request_id: "request" },
  instruction: "Suggested fix", citation: { revision_id: "source", pointer: "/observations/0" } };
const input = { operation: "direct_correction", item, target: { unit: "unit", artifact: "work", revision: "target" },
  instruction: "Authorized fix", recipients: ["a", "b"], stage_agent_workers: ["a", "b", "c"] } satisfies Omit<DispatchCheck, "authorizations">;
const authorization: DispatchAuthorization = { id: selectAuthorizationId(input), operation: input.operation, item: item.id, target: input.target,
  instruction: input.instruction, recipients: input.recipients, policy: "operator_required", authorized_by: "operator" };
const check: DispatchCheck = { ...input, authorizations: [authorization] };
const policy = { kind: "operator_required" as const };

test("dispatch authorization matches only the exact instruction, target and sorted recipient set", () => {
  expect(authorizeDispatch(policy, { ...check, recipients: ["b", "a"] })).toEqual({ ok: true, value: authorization });
  for (const values of [{ instruction: "Changed" }, { target: { ...check.target, revision: "other" } },
    { recipients: ["a", "b", "c"] }, { authorizations: [] }]) {
    expect(authorizeDispatch(policy, { ...check, ...values })).toMatchObject({ ok: false,
      error: { detail: "dispatch not authorized for this instruction, target and recipient set" } });
  }
});

test.each([["watch"], ["other_stage"], ["a", "a"], []])("dispatch refuses invalid recipients %j", (...recipients) => {
  expect(authorizeDispatch(policy, { ...check, recipients })).toMatchObject({ ok: false });
});

const round: AssignmentRound = { assignment: "assignment", authorization: authorization.id, decision: "decision", id: "round", instruction: authorization.instruction, ordinal: 1 };
const facts: AssessmentFacts = { artifact: "assessment", unit: "unit", revision: "assessed", approval: null,
  items: [item], assignments: [{ id: round.assignment, item: item.id, recipient: "a", target_unit: item.unit, target_artifact: "work" }],
  rounds: [round], updates: [], verifications: [], rejections: [], authorizations: [authorization] };

test("status projects all five assignment states", () => {
  const updated = { ...facts, updates: [{ round: round.id, revision: "update" }] };
  const verification = { id: "verification", round: round.id, assessment_revision: "assessed", update_revision: "update", outcome: "needs_further_work" as const };
  const returned = { ...updated, verifications: [verification] };
  const accepted = { ...returned, rejections: [{ id: "rejection", item: item.id, assignment: round.assignment, reason: "sufficient",
    assessment_revision: facts.revision, decision: "accept" }] };
  const verified = { ...updated, verifications: [{ ...verification, outcome: "verified" as const }] };
  expect([facts, updated, returned, verified, accepted].map(value => selectRoundProgress(value, round)))
    .toEqual(["awaiting_update", "awaiting_verification", "returned_for_update", "assessor_verified", "accepted_by_operator"]);
});

test("status groups both recipients under one feedback item", () => {
  const assignment = { ...facts.assignments[0], id: "second-assignment", recipient: "b" };
  const second = { ...round, id: "second-round", assignment: assignment.id };
  const status = selectAssessmentStatus({ ...facts, assignments: [...facts.assignments, assignment], rounds: [round, second] });
  expect(status.items).toMatchObject([{ item: item.id, assignments: [{ recipient: "a" }, { recipient: "b" }] }]);
});

test("round delivery uses committed instruction and citation and keeps its key for ordinary redelivery", () => {
  const rendered = renderRoundDelivery(round, item);
  expect(renderRoundDelivery({ ...round }, { ...item })).toBe(rendered);
  expect(rendered).toBe('Assignment round: round\nAuthorized fix\nCitation revision: source\nCitation pointer: "/observations/0"');
  const instruction = { action: { cause: { kind: "assignment_round", round: round.id } } } as EffectInstruction;
  expect(selectDeliveryKey(instruction)).toBe(round.id);
});

test("explicit assignment retries use a fresh key that stays stable on redelivery", () => {
  const first = { action: { cause: { kind: "assignment_round", round: round.id } },
    attempt: { action_id: "initial", seq: 1 } } as EffectInstruction;
  const retry = { ...first, action: { ...first.action, cause: { kind: "assignment_round", round: round.id, retry: "retry-event" } },
    attempt: { action_id: "retry-action", seq: 1 } } as EffectInstruction;
  expect(selectDeliveryKey(first)).toBe(round.id);
  expect(selectDeliveryKey(retry)).not.toBe(selectDeliveryKey(first));
  expect(selectDeliveryKey(retry)).toBe(selectDeliveryKey({ ...retry }));
});

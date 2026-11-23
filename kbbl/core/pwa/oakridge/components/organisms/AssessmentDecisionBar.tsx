import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Checkbox } from "../../../components/atoms/Checkbox";
import { Select } from "../../../components/atoms/Select";
import { TextArea } from "../../../components/atoms/TextArea";
import { Button } from "../../../components/atoms/Button";
import { randomUuid } from "../../../lib/random-uuid";
import { authorizeAssessmentFeedback, createAssessmentFeedback, decideAssessment, type AssessmentAddress } from "../../client-assessment";
import type { ParkedGate } from "../../artifact-types";
import type { OperatorFeedbackDisposition, OperatorPathSegment } from "../../operator-contracts/core-client/core-types";
import type { OperatorAssessmentRead } from "../../operator-contracts/projections/assessment-status";
import type { OperatorProjectedWorker } from "../../operator-contracts/projections/unit-view";

function valuesAtPath(body: unknown, path: readonly OperatorPathSegment[]): unknown[] {
  const [segment, ...rest] = path;
  if (!segment) return [body];
  if (segment.kind === "each") return Array.isArray(body) ? body.flatMap((item) => valuesAtPath(item, rest)) : [];
  if (!body || typeof body !== "object" || !Object.hasOwn(body, segment.value)) return [];
  return valuesAtPath((body as Readonly<Record<string, unknown>>)[segment.value], rest);
}

interface Props {
  readonly address: AssessmentAddress;
  readonly status: OperatorAssessmentRead;
  readonly gate?: ParkedGate;
  readonly assessed: string | null;
  readonly workers: readonly OperatorProjectedWorker[];
  readonly paths: readonly (readonly OperatorPathSegment[])[];
  readonly body: unknown;
  readonly onRecorded: () => void;
}

interface Choice {
  readonly kind: "reject" | "dispatch";
  readonly instruction: string;
  readonly recipients: string[];
}
const EMPTY: Choice = { kind: "reject", instruction: "", recipients: [] };

export function AssessmentDecisionBar({ address, status, gate, assessed, workers, paths, body, onRecorded }: Props) {
  const [choices, setChoices] = useState<Readonly<Record<string, Choice>>>({});
  const [followups, setFollowups] = useState<Readonly<Record<string, string>>>({});
  const [newInstruction, setNewInstruction] = useState("");
  const recipients = workers.filter((worker) => worker.kind === "agent");
  const proposals = new Map(paths.flatMap((path) => valuesAtPath(body, path)).flatMap((value) => {
    if (typeof value !== "object" || value === null || !("key" in value) || !("instruction" in value)
      || typeof value.key !== "string" || typeof value.instruction !== "string") return [];
    return [[value.key, value.instruction] as const];
  }));
  const updateChoice = (item: string, update: Partial<Choice>) =>
    setChoices((prior) => ({ ...prior, [item]: { ...(prior[item] ?? EMPTY), ...update } }));
  const dispositions: OperatorFeedbackDisposition[] = [
    ...status.items.flatMap(({ item }): OperatorFeedbackDisposition[] => {
      const choice = choices[item];
      if (!choice?.instruction.trim()) return [];
      if (choice.kind === "reject" && status.unresolved_proposals.includes(item)) return [{ kind: "reject", item, reason: choice.instruction.trim() }];
      return choice.recipients.length ? [{ kind: "dispatch", item, instruction: choice.instruction.trim(), recipients: choice.recipients }] : [];
    }),
    ...Object.entries(followups).flatMap(([assignment, reason]): OperatorFeedbackDisposition[] =>
      reason.trim() ? [{ kind: "reject_follow_up", assignment, reason: reason.trim() }] : []),
  ];
  const mutation = useMutation({ mutationFn: (send: () => Promise<unknown>) => send(), onSuccess: onRecorded });
  const review = gate?.gate_step;
  const isPending = status.approval.kind === "pending";
  return <section aria-label="Assessment decisions">
    {status.items.map((item) => {
      const source = status.item_sources.find((candidate) => candidate.item === item.item);
      const choice = choices[item.item] ?? EMPTY;
      const unresolved = status.unresolved_proposals.includes(item.item);
      const operation = source?.origin === "operator" ? "direct_correction" : "dispatch_feedback";
      const target = gate?.decision_definitions?.find((entry) => entry.operation === operation && entry.is_available !== false)?.submit;
      const canAuthorize = target?.kind === "review" && (unresolved || (source?.origin === "operator" && item.assignments.length === 0) ||
        item.assignments.some((assignment) => assignment.progress === "returned_for_update"));
      const dispatching = !unresolved || choice.kind === "dispatch";
      return <fieldset key={item.item} disabled={mutation.isPending || !isPending}>
        <legend>{(source?.proposal_key && proposals.get(source.proposal_key)) || source?.instruction || item.item}</legend>
        {(unresolved || canAuthorize) && <>
          {unresolved && <Select aria-label="Disposition" value={choice.kind}
            onChange={(event) => updateChoice(item.item, { kind: event.target.value === "dispatch" ? "dispatch" : "reject" })}>
            <option value="reject">Reject</option><option value="dispatch">Dispatch</option>
          </Select>}
          <TextArea aria-label={unresolved && choice.kind === "reject" ? "Rejection reason" : "Instruction"}
            value={choice.instruction} onChange={(event) => updateChoice(item.item, { instruction: event.target.value })} />
          {(canAuthorize && dispatching) && recipients.map((worker) => <label key={worker.key}>
            <Checkbox type="checkbox" checked={choice.recipients.includes(worker.key)} onChange={(event) => updateChoice(item.item, {
              recipients: event.target.checked ? [...choice.recipients, worker.key] : choice.recipients.filter((key) => key !== worker.key),
            })} /> {worker.label}
          </label>)}
          {canAuthorize && dispatching && <Button disabled={!choice.instruction.trim() || !choice.recipients.length} onClick={() => mutation.mutate(() =>
            authorizeAssessmentFeedback(address, { request_id: randomUuid(), item: item.item, target_revision: target.target_revision_id,
              instruction: choice.instruction.trim(), recipients: choice.recipients }))}>Authorize dispatch</Button>}
        </>}
        {item.assignments.map((assignment) => <div key={assignment.assignment}>
          {workers.find((worker) => worker.key === assignment.recipient)?.label ?? assignment.recipient} · {assignment.progress.replaceAll("_", " ")}
          {assignment.progress === "returned_for_update" && <TextArea aria-label="Follow-up rejection reason" value={followups[assignment.assignment] ?? ""}
            onChange={(event) => setFollowups({ ...followups, [assignment.assignment]: event.target.value })} />}
        </div>)}
      </fieldset>;
    })}
    {isPending && <div>
      <TextArea aria-label="Operator feedback" value={newInstruction} onChange={(event) => setNewInstruction(event.target.value)} />
      <Button disabled={!newInstruction.trim() || mutation.isPending} onClick={() => mutation.mutate(async () => {
        await createAssessmentFeedback(address, { request_id: randomUuid(), instruction: newInstruction.trim(), citation: null });
        setNewInstruction("");
      })}>Add feedback</Button>
    </div>}
    {isPending && review && assessed && gate?.decision_definitions?.flatMap((definition) => {
      const submit = definition.submit;
      if (submit.kind !== "review" || (definition.operation !== "approve_assessment" && definition.operation !== "dispatch_feedback" && definition.operation !== "direct_correction")) return [];
      return [<Button key={submit.decision} variant={submit.effect === "approve" ? "primary" : "secondary"}
        disabled={mutation.isPending || definition.is_available === false}
        onClick={() => mutation.mutate(() => decideAssessment(address, review, {
          request_id: randomUuid(), decision: submit.decision, target: status.assessment_revision, assessed_revision: assessed,
          dispositions: dispositions.filter((entry) => entry.kind === "dispatch"
            ? definition.operation === (status.item_sources.find((source) => source.item === entry.item)?.origin === "operator" ? "direct_correction" : "dispatch_feedback")
            : entry.kind === "reject" || definition.operation === "approve_assessment"),
        }))}>{definition.label}</Button>];
    })}
    {mutation.error && <p role="alert">{mutation.error.message}</p>}
  </section>;
}

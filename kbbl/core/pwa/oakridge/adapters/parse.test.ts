import { expect, test } from "vitest";
import { sampleCohort } from "../__fixtures__/read-models";
import type { OperatorAttemptIntentView, OperatorAttemptView, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { OperatorRevisionState } from "../operator-contracts/core-client/core-types";
import { parseUnitView, parseUnitViews } from "./parse";

// An HTTP payload may carry malformed intent; the API boundary must reject it.
interface AttemptIntentPayload extends Omit<OperatorAttemptView, "intent"> { readonly intent?: unknown }
interface UnitIntentPayload extends Omit<OperatorUnitView, "attempts"> { readonly attempts: readonly AttemptIntentPayload[] }
const capturedAttempt = sampleCohort.attempts[0];
if (!capturedAttempt) throw new Error("captured cohort requires an attempt");
const withIntent = (intent: unknown): UnitIntentPayload => ({ ...sampleCohort, attempts: [{ ...capturedAttempt, intent }] });
const previous: OperatorRevisionState = { id: "revision-before", unit: sampleCohort.unit_id, artifact: "document", seq: 1, body: { summary: "Earlier" },
  by: null, predecessor: null, subject: null, decision_cursor: 0 };
const intent: OperatorAttemptIntentView = { inputs: { source: { revision_id: previous.id } },
  engine_inputs: { previous, feedback: [{ id: "decision-1", review: "review-1", decision: "request_changes", target: previous.id, payload: { feedback: "Revise" } }], subject: previous },
  prompt: { path: "prompts/agent.md", digest: "sha256:recorded" } };

const acceptedIntents: readonly (OperatorAttemptIntentView | null)[] = [null, intent,
  { inputs: null, engine_inputs: { previous: null, feedback: [], subject: null }, prompt: null },
  { inputs: [false, 2, "text", {}], engine_inputs: { previous: { id: "minimal", unit: "unit", artifact: "artifact", seq: 1, body: null }, feedback: [], subject: null }, prompt: null }];
test.each(acceptedIntents)("accepts valid recorded or absent intent %# without replacing its values", (value) => {
  const payload = withIntent(value);
  const single = parseUnitView(payload);
  const list = parseUnitViews([payload]);
  expect([single.ok && single.value.attempts[0]?.intent === value, list.ok && list.value[0]?.attempts[0]?.intent === value]).toEqual([true, true]);
});

interface InvalidIntentCase { readonly name: string; readonly value: unknown }
const invalidIntents: readonly InvalidIntentCase[] = [
  { name: "missing intent", value: undefined },
  { name: "scalar intent", value: "recorded" },
  { name: "array intent", value: [] },
  { name: "missing inputs", value: { engine_inputs: intent.engine_inputs, prompt: null } },
  { name: "non-JSON inputs", value: { ...intent, inputs: { source: undefined } } },
  { name: "non-finite input number", value: { ...intent, inputs: NaN } },
  { name: "missing engine inputs", value: { inputs: {}, prompt: null } },
  { name: "null engine inputs", value: { ...intent, engine_inputs: null } },
  { name: "missing previous", value: { ...intent, engine_inputs: { feedback: [], subject: null } } },
  { name: "missing subject", value: { ...intent, engine_inputs: { previous: null, feedback: [] } } },
  { name: "malformed previous revision id", value: { ...intent, engine_inputs: { ...intent.engine_inputs, previous: { ...previous, id: 2 } } } },
  { name: "malformed subject revision unit", value: { ...intent, engine_inputs: { ...intent.engine_inputs, subject: { ...previous, unit: null } } } },
  { name: "missing revision body", value: { ...intent, engine_inputs: { ...intent.engine_inputs, previous: { id: "r", unit: "u", artifact: "a", seq: 1 } } } },
  { name: "invalid revision sequence", value: { ...intent, engine_inputs: { ...intent.engine_inputs, subject: { ...previous, seq: -1 } } } },
  { name: "invalid optional predecessor", value: { ...intent, engine_inputs: { ...intent.engine_inputs, previous: { ...previous, predecessor: {} } } } },
  { name: "invalid optional decision cursor", value: { ...intent, engine_inputs: { ...intent.engine_inputs, previous: { ...previous, decision_cursor: "0" } } } },
  { name: "non-array feedback", value: { ...intent, engine_inputs: { ...intent.engine_inputs, feedback: {} } } },
  { name: "invalid feedback entry", value: { ...intent, engine_inputs: { ...intent.engine_inputs, feedback: [null] } } },
  { name: "missing feedback target", value: { ...intent, engine_inputs: { ...intent.engine_inputs, feedback: [{ id: "d", review: "r", decision: "revise", payload: {} }] } } },
  { name: "missing feedback payload", value: { ...intent, engine_inputs: { ...intent.engine_inputs, feedback: [{ id: "d", review: "r", decision: "revise", target: "revision" }] } } },
  { name: "missing prompt", value: { inputs: {}, engine_inputs: intent.engine_inputs } },
  { name: "scalar prompt", value: { ...intent, prompt: "prompts/agent.md" } },
  { name: "invalid prompt path", value: { ...intent, prompt: { path: 2, digest: "digest" } } },
  { name: "missing prompt digest", value: { ...intent, prompt: { path: "prompts/agent.md" } } },
];
test.each(invalidIntents)("rejects $name at both unit-view boundaries", ({ value }) => {
  const payload = withIntent(value);
  expect([parseUnitView(payload).ok, parseUnitViews([payload]).ok]).toEqual([false, false]);
});

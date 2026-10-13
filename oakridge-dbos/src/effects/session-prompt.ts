import type { AttemptStatus, Mode } from "../core-client/core-types";
import type { CreatedArtifact, EffectInstruction } from "../domain/effect-instruction";
import { renderTemplate, renderValue } from "../domain/prompt-template";

export { renderTemplate, renderValue } from "../domain/prompt-template";

/**
 * What an agent receives (part 1 §2.5), built by the engine from config and
 * state; nothing here is hand-written per workflow. A session starts with a
 * preamble that carries its publication block, and every attempt's task (the
 * mode's prompt, and for a fresh session the handoff) arrives as one input.
 * Both are pure functions of their inputs, so a re-render after a crash is
 * the same text and kbbl's keyed ensure and delivery stay idempotent.
 *
 * Discussion threads never reach an agent: they are for people. What reaches
 * it is the review form an operator submitted, as the decision's payload.
 */

/** The latest revision of an artifact the worker creates; null before its first. */
export interface LatestRevision { readonly artifact: string; readonly revision_id: string | null; readonly body: unknown }
/** How the worker's previous attempt ended. */
export interface PreviousAttempt { readonly mode: Mode; readonly status: AttemptStatus }

/** State read at session start, beside the instruction, that a task is rendered from. */
export interface SessionTaskContext {
  /** The mode prompt's template text, by its pinned digest. */
  readonly prompt_text: string;
  /** The `prompts.handoff` template text; null when none is pinned. */
  readonly handoff_text: string | null;
  readonly latest: readonly LatestRevision[];
  readonly previous_attempt: PreviousAttempt | null;
}

/** The rows `readSessionHistory` returns, as this module reads them. */
export interface SessionHistoryRows {
  readonly earlier_attempts: readonly { readonly mode: Mode; readonly status: AttemptStatus }[];
  readonly latest: readonly { readonly id: string; readonly artifact: string; readonly body: unknown }[];
}
/** The pinned prompt texts an attempt renders. */
export interface SessionPromptTexts { readonly prompt_text: string; readonly handoff_text: string | null }

export function selectSessionTaskContext(instruction: EffectInstruction, history: SessionHistoryRows, texts: SessionPromptTexts): SessionTaskContext {
  const creates = instruction.worker.kind === "agent" ? instruction.worker.creates : [];
  const latest = new Map(history.latest.map((revision) => [revision.artifact, revision]));
  const previous = history.earlier_attempts.at(-1);
  return {
    ...texts,
    latest: creates.map(({ key }) => {
      const revision = latest.get(key);
      return { artifact: key, revision_id: revision?.id ?? null, body: revision?.body ?? null };
    }),
    previous_attempt: previous ? { mode: previous.mode, status: previous.status } : null,
  };
}

const inputValues = (instruction: EffectInstruction): { readonly [key: string]: unknown } =>
  typeof instruction.inputs === "object" && instruction.inputs !== null && !Array.isArray(instruction.inputs)
    ? instruction.inputs as { readonly [key: string]: unknown } : {};

/** The mode prompt with the declared inputs and the engine inputs for its mode (`previous`, `feedback`, `subject`). */
export function renderModePrompt(instruction: EffectInstruction, prompt_text: string): string {
  const { previous, feedback, subject } = instruction.engine_inputs;
  return renderTemplate(prompt_text, { ...inputValues(instruction), previous, feedback, subject });
}

/** The fields a `prompts.handoff` template may read beside the declared inputs; the compiler checks the same list. */
export interface HandoffFields {
  readonly artifacts: { readonly [artifact: string]: { readonly revision: string; readonly body: unknown } | null };
  readonly feedback: unknown;
  readonly previous_attempt: PreviousAttempt | null;
}
export function selectHandoffFields(instruction: EffectInstruction, context: SessionTaskContext): HandoffFields {
  return {
    artifacts: Object.fromEntries(context.latest.map((latest) =>
      [latest.artifact, latest.revision_id === null ? null : { revision: latest.revision_id, body: latest.body }])),
    feedback: instruction.engine_inputs.feedback,
    previous_attempt: context.previous_attempt,
  };
}

const describeAttempt = (attempt: PreviousAttempt): string => {
  const status = attempt.status;
  const ended = status.kind === "failed" ? `failed (${status.code}): ${status.detail}` : status.kind;
  return `The previous ${attempt.mode.kind} attempt ${status.kind === "running" || status.kind === "pending" ? "is" : "ended"} ${ended}.`;
};

/** The engine's own wording of a handoff, used when the worker declares no `prompts.handoff`. */
export function renderDefaultHandoff(fields: HandoffFields): string {
  const artifacts = Object.entries(fields.artifacts).map(([artifact, latest]) => latest === null
    ? `- \`${artifact}\`: not published yet`
    : `- \`${artifact}\`, revision \`${latest.revision}\`:\n\n${indent(renderValue(latest.body))}`);
  return [
    "## Handoff",
    "This session starts fresh. Earlier attempts at this work ran in other sessions; this is what they left.",
    "",
    "### Latest revisions",
    ...artifacts,
    "",
    "### Feedback",
    renderValue(fields.feedback),
    ...(fields.previous_attempt ? ["", "### Previous attempt", describeAttempt(fields.previous_attempt)] : []),
  ].join("\n");
}
const indent = (text: string): string => text.split("\n").map((line) => `    ${line}`).join("\n");

/**
 * The handoff a fresh session starts with, when there is anything to hand
 * off: a fresh worker's first attempt has no history and gets none.
 */
export function renderHandoff(instruction: EffectInstruction, context: SessionTaskContext): string | null {
  if (instruction.worker.kind !== "agent" || instruction.worker.session !== "fresh") return null;
  if (context.previous_attempt === null && context.latest.every((latest) => latest.revision_id === null)) return null;
  const fields = selectHandoffFields(instruction, context);
  return context.handoff_text === null ? renderDefaultHandoff(fields)
    : renderTemplate(context.handoff_text, { ...inputValues(instruction), ...fields });
}

/** Where this task's publications attach: each artifact's current revision, and the revision under review. */
export function renderTaskPublication(instruction: EffectInstruction, context: SessionTaskContext): string {
  const latest = new Map(context.latest.map((revision) => [revision.artifact, revision.revision_id]));
  const creates = instruction.worker.kind === "agent" ? instruction.worker.creates : [];
  const subject = instruction.engine_inputs.subject;
  return [
    "## Publishing this task",
    "Publish these artifacts with the endpoint and secret from the start of this session:",
    ...creates.map((artifact) => {
      const current = latest.get(artifact.key) ?? null;
      return `- \`${artifact.key}\`: ${current === null ? "no revision yet, so send `predecessor: null`" : `current revision \`${current}\`, so send it as \`predecessor\``}`;
    }),
    subject === null ? "Send `subject: null`." : `You are reviewing revision \`${subject.id}\`: send it as \`subject\`.`,
  ].join("\n");
}

/** One attempt's input: the handoff (fresh sessions), the mode prompt, and where to publish. */
export function renderSessionTask(instruction: EffectInstruction, context: SessionTaskContext): string {
  const handoff = renderHandoff(instruction, context);
  return [handoff, renderModePrompt(instruction, context.prompt_text), renderTaskPublication(instruction, context)]
    .filter((part): part is string => part !== null).join("\n\n");
}

/** What a session's preamble is rendered from: all of it fixed for the session, so every attempt's ensure sends the same spec. */
export interface SessionPreambleInput {
  readonly run_id: string;
  readonly unit: string;
  readonly worker: string;
  readonly creates: readonly CreatedArtifact[];
  /** The backend's base URL as agents reach it: they publish to it directly, not through the kbbl proxy. */
  readonly publish_base_url: string;
  readonly secret: string;
}

export function selectPublishEndpoint(input: Pick<SessionPreambleInput, "run_id" | "unit" | "publish_base_url">, artifact: string): string {
  const base = input.publish_base_url.replace(/\/+$/, "");
  return `${base}/api/runs/${encodeURIComponent(input.run_id)}/units/${encodeURIComponent(input.unit)}/artifacts/${encodeURIComponent(artifact)}`;
}

/** The publication block (part 1 §2.5 item 2), generated from config: each artifact's endpoint and schema, and the session's secret. */
export function renderSessionPreamble(input: SessionPreambleInput): string {
  return [
    `You are the Oakridge worker \`${input.worker}\` on unit \`${input.unit}\` of run \`${input.run_id}\`.`,
    "Your tasks arrive as messages in this session. Reply \"ready\" now, and wait for the first task.",
    "",
    "## Publishing your work",
    "Each task says which artifacts to publish. Publish every one of them before you finish the task: a task that ends without publishing every artifact it creates fails.",
    "",
    "Publish an artifact with an HTTP PUT to its endpoint, with your publication secret as a bearer token and a JSON body:",
    "",
    "    curl -sS -X PUT '<endpoint>' -H 'Authorization: Bearer <secret>' -H 'Content-Type: application/json' --data '<body>'",
    "",
    "The body is `{\"request_id\": <a new unique id for each different publication>, \"body\": <the artifact, matching its schema>, \"predecessor\": <the revision id the task gives, or null>, \"subject\": <the revision id the task asks you to review, or null>}`.",
    "A 200 or 201 response means the revision was recorded. A 409 response says why it was refused: correct it and publish again with a new request_id.",
    "",
    "Artifacts:",
    ...input.creates.flatMap((artifact) => [
      `- \`${artifact.key}\``,
      `  endpoint: ${selectPublishEndpoint(input, artifact.key)}`,
      `  schema: ${JSON.stringify(artifact.schema)}`,
    ]),
    "",
    `Your publication secret: ${input.secret}`,
    "It is valid only while one of your tasks is running. Do not write it into any file or artifact.",
  ].join("\n");
}

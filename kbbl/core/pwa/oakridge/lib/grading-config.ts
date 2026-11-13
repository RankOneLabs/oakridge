import type { ObservationJsonValue as Json } from "../grading-contracts/domain/primitives";
import type { ObservationConfigurationIssue, ObservationPublishedConfiguration } from "../grading-contracts/grading/configuration";
import type { ObservationStoredDraft } from "../grading-contracts/grading/configuration-store";
import type { ObservationPublicationError, ObservationPublicationOutcome } from "../grading-contracts/grading/publication";

export type GradingPath = readonly (string | number)[];
export interface GradingDraftState {
  readonly definitions: readonly Json[];
  readonly baseDigest: string | null;
  readonly latestVersionSeen: number | null;
  readonly dirty: boolean;
}
export type GradingFeedback =
  | { kind: "saving" } | { kind: "saved"; digest: string }
  | { kind: "validating" } | { kind: "validated" }
  | { kind: "validation_failed"; issues: readonly ObservationConfigurationIssue[] }
  | { kind: "publishing" }
  | { kind: "published" | "unchanged" | "reapplied"; version: number; hash: string }
  | { kind: "runtime_failed"; failure: "registration_failed" | "persistence_failed" | "runtime_apply_failed"; detail: string }
  | { kind: "conflict"; target: "draft" | "version" }
  | { kind: "restart_required"; detail: string }
  | { kind: "transport_error"; detail: string };
export interface DefinitionSummary {
  readonly index: number; readonly id: string; readonly scope: string;
  readonly targets: readonly { artifact: string; selector: string }[];
  readonly evidence: readonly string[]; readonly text: string; readonly allowedValues: string;
  readonly evaluators: readonly { runner: string; model: string }[];
  readonly targetsText: string; readonly evidenceText: string; readonly evaluatorsText: string;
}
export interface ConfigurationHeader { readonly published: string; readonly draft: string }
export interface GradingDifference {
  readonly kind: "added" | "removed" | "changed";
  readonly path: GradingPath; readonly before: Json | undefined; readonly after: Json | undefined;
}
export type JsonParseResult = { ok: true; value: Json } | { ok: false; error: string };
export const jsonObject = (value: Json | undefined): { readonly [key: string]: Json } =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as { readonly [key: string]: Json } : {};
export const jsonList = (value: Json | undefined): readonly Json[] => Array.isArray(value) ? value : [];
export const jsonText = (value: Json | undefined): string => typeof value === "string" ? value : "";
export const atPath = (value: Json | undefined, path: GradingPath): Json | undefined =>
  path.reduce<Json | undefined>((node, key) => Array.isArray(node) ? node[Number(key)] : jsonObject(node)[key], value);
export function replaceAtPath(value: Json, path: GradingPath, replacement: Json): Json {
  const [key, ...rest] = path;
  if (key === undefined) return replacement;
  if (typeof key === "number") {
    const items = [...jsonList(value)];
    items[key] = replaceAtPath(items[key] ?? null, rest, replacement);
    return items;
  }
  const object = jsonObject(value);
  return { ...object, [key]: replaceAtPath(object[key] ?? null, rest, replacement) };
}
export const createDraft = (draft: ObservationStoredDraft | null, latestVersionSeen: number | null): GradingDraftState =>
  ({ definitions: draft?.document.definitions ?? [], baseDigest: draft?.digest ?? null, latestVersionSeen, dirty: false });
export const replaceDefinitions = (state: GradingDraftState, definitions: readonly Json[]): GradingDraftState => ({ ...state, definitions, dirty: true });
export const editDraft = (state: GradingDraftState, path: GradingPath, value: Json): GradingDraftState =>
  replaceDefinitions(state, jsonList(replaceAtPath(state.definitions, path, value)));
export const saveSucceeded = (state: GradingDraftState, saved: ObservationStoredDraft): GradingDraftState =>
  ({ ...state, definitions: saved.document.definitions, baseDigest: saved.digest, dirty: false });
export const saveFailed = (state: GradingDraftState): GradingDraftState => state;
// JSON parsing is the text-input IO boundary. All domain correctness belongs to observation.
export function parseJson(text: string): JsonParseResult {
  try { return { ok: true, value: JSON.parse(text) as Json }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON" }; }
}
export function parseDefinitions(text: string): JsonParseResult {
  const parsed = parseJson(text);
  return parsed.ok && !Array.isArray(parsed.value) ? { ok: false, error: "Enter the whole definitions array as JSON." } : parsed;
}
export function definitionSummaries(definitions: readonly Json[]): readonly DefinitionSummary[] {
  return definitions.map((value, index) => {
    const definition = jsonObject(value), question = jsonObject(definition.question);
    const targets = jsonList(definition.targets).map((target) => ({ artifact: jsonText(jsonObject(target).artifact), selector: jsonText(jsonObject(target).selector) }));
    const evidence = jsonList(definition.evidence).map((reference) => typeof reference === "string" ? reference : jsonText(jsonObject(reference).capability));
    const evaluators = jsonList(definition.evaluators).map((entry) => ({ runner: jsonText(jsonObject(entry).runner), model: jsonText(jsonObject(entry).model) }));
    return { index, id: jsonText(definition.id) || `Definition ${index + 1}`, scope: jsonText(definition.scope),
      targets,
      evidence,
      text: jsonText(question.text) || "No question text", allowedValues: JSON.stringify(question.values ?? null),
      evaluators, targetsText: targets.map((target) => `${target.artifact} ${target.selector}`).join(", ") || "None",
      evidenceText: evidence.join(", ") || "None",
      evaluatorsText: evaluators.map((entry) => `${entry.runner}${entry.model ? ` · ${entry.model}` : ""}`).join(", ") || "None" };
  });
}
export const configurationHeader = (state: GradingDraftState, latest: ObservationPublishedConfiguration | null): ConfigurationHeader => ({
  published: latest ? `Latest published version ${latest.version} · ${latest.published_at}` : "No published version",
  draft: state.dirty ? "Unsaved local edits" : state.baseDigest ? "Saved draft" : "No draft",
});
export function configurationDiff(before: Json | undefined, after: Json | undefined, path: GradingPath = []): readonly GradingDifference[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before === undefined || after === undefined) return [{ kind: before === undefined ? "added" : "removed", path, before, after }];
  if (Array.isArray(before) && Array.isArray(after)) return Array.from({ length: Math.max(before.length, after.length) }, (_, index) => configurationDiff(before[index], after[index], [...path, index])).flat();
  if (before !== null && after !== null && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const oldObject = jsonObject(before), newObject = jsonObject(after);
    return [...new Set([...Object.keys(oldObject), ...Object.keys(newObject)])].flatMap((key) => configurationDiff(oldObject[key], newObject[key], [...path, key]));
  }
  return [{ kind: "changed", path, before, after }];
}
export const publicationFeedback = (outcome: ObservationPublicationOutcome): GradingFeedback => ({ kind: outcome.outcome, version: outcome.version, hash: outcome.hash });
export function publicationFailure(error: ObservationPublicationError): GradingFeedback {
  switch (error.kind) {
    case "invalid_configuration": return { kind: "validation_failed", issues: error.issues };
    case "draft_conflict": return { kind: "conflict", target: "draft" };
    case "version_conflict": return { kind: "conflict", target: "version" };
    case "unconfigured_credential": return { kind: "restart_required", detail: error.detail };
    default: return { kind: "runtime_failed", failure: error.kind, detail: error.detail };
  }
}
export const sectionIssues = (issues: readonly ObservationConfigurationIssue[], index: number, path: GradingPath): readonly ObservationConfigurationIssue[] =>
  issues.filter((issue) => issue.definition_index === index && (issue.path.length === 0 || [index, ...path].every((key, offset) => issue.path[offset] === key)));
export function feedbackText(feedback: GradingFeedback): string {
  switch (feedback.kind) {
    case "saving": return "Saving draft…";
    case "saved": return `Draft saved · ${feedback.digest}`;
    case "validating": return "Validating saved draft…";
    case "validated": return "Saved draft is valid.";
    case "validation_failed": return "Validation failed. Review the issues below.";
    case "publishing": return "Publishing configuration…";
    case "published": return `Published version ${feedback.version} · ${feedback.hash}`;
    case "unchanged": return `Unchanged · version ${feedback.version} · ${feedback.hash}`;
    case "reapplied": return `Reapplied version ${feedback.version} · ${feedback.hash}`;
    case "conflict": return `${feedback.target === "draft" ? "Draft" : "Version"} conflict. Your local edits are preserved. Reload before retrying.`;
    case "restart_required": return `Restart required: ${feedback.detail}`;
    case "runtime_failed": return `${feedback.failure}: ${feedback.detail}`;
    case "transport_error": return `Request failed: ${feedback.detail}`;
  }
}

/** Published contracts are JSON documents, while drafts deliberately permit incomplete values. */
export const publishedDefinitions = (document: ObservationPublishedConfiguration | null): readonly Json[] =>
  document === null ? [] : document.definitions as unknown as readonly Json[];
export interface GradingJsonInput { readonly path: GradingPath; readonly text: string; readonly error: string | null }
export type GradingJsonInputs = Readonly<Record<string, GradingJsonInput>>;
export const hasJsonErrors = (inputs: GradingJsonInputs): boolean => Object.values(inputs).some((input) => input.error !== null);
export const validationIssues = (feedback: GradingFeedback | null): readonly ObservationConfigurationIssue[] => feedback?.kind === "validation_failed" ? feedback.issues : [];

export const definitionWithScope = (definition: Json, scope: Json): Json => {
  const { task_ids, ...fields } = jsonObject(definition);
  return scope === "per_task" ? { ...fields, scope, task_ids: task_ids ?? "" } : { ...fields, scope };
};
export const evaluatorWithRunner = (entry: Json, runner: Json): Json => {
  if (runner === "human") return { runner };
  const fields = jsonObject(entry);
  return { ...fields, runner, instructions: fields.runner === runner ? fields.instructions ?? {} : {} };
};

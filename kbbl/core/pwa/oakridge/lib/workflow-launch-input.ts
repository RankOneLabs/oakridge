import type { RepositoryInputDraft } from "../launch-types";
import type { FinalMergePolicy, RepositoryKey } from "../run-types";
import { validateRepositoryInputs } from "../repository-inputs";
import { epicSlugFromTitle } from "./launch-config";
import { selectMissingBriefNotesDetail, type BriefNotesSource } from "./brief-notes";
import type { Result } from "../../lib/result";
import type { OperatorDefinitionBundle } from "../operator-contracts/projections/definition-view";
import type { OperatorSchemaShape } from "../operator-contracts/projections/schema-view";
import { indexProjectedSchemas, matchesProjectedSchema, type ProjectedSchemas } from "./projected-schema";

export type LaunchInputDraft = Readonly<Record<string, string>>;
export interface LaunchInputRefusal { readonly detail: string }
/** Study's slice limits as the operator types them; the cap is in dollars. */
export interface StudySliceDraft {
  readonly case_limit: string;
  readonly cap_dollars: string;
}
/** The limits study's own tests launch with: six pilot cases and a $10 paid slice. */
export const DEFAULT_STUDY_SLICE_DRAFT: StudySliceDraft = { case_limit: "6", cap_dollars: "10.00" };
interface StudySliceLimits { readonly slice_case_limit: number; readonly slice_cap_cents: number }

const refuse = (detail: string): Result<never, LaunchInputRefusal> => ({ ok: false, error: { detail } });
const WHOLE = /^\d+$/;
const DOLLARS = /^(\d+)(?:\.(\d{1,2}))?$/;

/** At least one case, and a cap of at least one cent, in whole cents; a number too large to send exactly is refused. */
export function selectStudySliceLimits(draft: StudySliceDraft): Result<StudySliceLimits, LaunchInputRefusal> {
  const caseLimit = draft.case_limit.trim();
  const cases = Number(caseLimit);
  if (!WHOLE.test(caseLimit) || !Number.isSafeInteger(cases) || cases < 1) return refuse("Slice case limit must be a whole number of at least 1.");
  const dollars = DOLLARS.exec(draft.cap_dollars.trim());
  if (!dollars) return refuse("Slice spending cap must be an amount in dollars, such as 10 or 12.50.");
  const cents = Number(dollars[1]) * 100 + Number((dollars[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return refuse("Slice spending cap is too large.");
  if (cents < 1) return refuse("Slice spending cap must be more than $0.");
  return { ok: true, value: { slice_case_limit: cases, slice_cap_cents: cents } };
}

/** Mirrors the shared root input in workflow-config/shared/workflow-common.yaml. */
interface EpicLaunchRepository {
  readonly key: RepositoryKey;
  readonly preparation: { readonly repository_path: string; readonly expected_head: null };
  readonly forge: { readonly owner: string; readonly name: string; readonly build_base: string; readonly final_base: string };
}

interface EpicLaunchInput {
  readonly title: string;
  readonly spec: string;
  readonly repositories: readonly EpicLaunchRepository[];
  readonly primary_repository_key: RepositoryKey;
  readonly final_merge_policy: "require_merge" | "allow_close_without_merge";
}

const EPIC_FIELDS = ["title", "spec", "repositories", "primary_repository_key", "final_merge_policy"] satisfies (keyof EpicLaunchInput)[];
const SLICE_FIELDS = ["slice_case_limit", "slice_cap_cents"] satisfies (keyof StudySliceLimits)[];

export interface EpicLaunchDraft {
  readonly title: string;
  readonly notes: string;
  readonly source: BriefNotesSource;
  readonly policy: FinalMergePolicy;
  readonly repositories: RepositoryInputDraft[];
}

function selectEpicInput(draft: EpicLaunchDraft): Result<EpicLaunchInput, LaunchInputRefusal> {
  const title = draft.title.trim();
  const slug = epicSlugFromTitle(title);
  if (!slug) return refuse("Epic title must include a letter or number.");
  const spec = draft.notes.trim();
  if (!spec) return refuse(selectMissingBriefNotesDetail(draft.source));
  const result = validateRepositoryInputs(draft.repositories);
  if (!result.ok) return result;
  const repositories = result.repositories.map((repository) => ({
    key: repository.key,
    preparation: { repository_path: repository.path, expected_head: null },
    forge: { owner: repository.forge_owner, name: repository.forge_name,
      build_base: `epic/${slug}`, final_base: repository.integration_branch },
  }));
  return { ok: true, value: { title, spec, repositories, primary_repository_key: repositories[0].key,
    final_merge_policy: draft.policy === "guarded" ? "require_merge" : "allow_close_without_merge" } };
}

export interface LaunchField {
  readonly key: string;
  readonly schema: string;
  readonly shape: OperatorSchemaShape;
  readonly optional: boolean;
}
export interface LaunchInputSchema {
  readonly root: string;
  readonly schemas: ProjectedSchemas;
  readonly form: "development" | "study" | "generic";
  readonly additionalFields: readonly LaunchField[];
}

export function selectLaunchInputSchema(bundle: OperatorDefinitionBundle): LaunchInputSchema | null {
  const root = bundle.units.find((unit) => unit.key === bundle.root)?.input_schema;
  const schemas = indexProjectedSchemas(bundle.schemas);
  if (!root) return null;
  const record = schemas.get(root);
  if (record?.kind !== "record") return null;
  const covered: readonly string[] = bundle.key === "study" ? [...EPIC_FIELDS, ...SLICE_FIELDS] : EPIC_FIELDS;
  const form = (bundle.key === "development" || bundle.key === "study")
    && covered.every((key) => record.fields.some((field) => field.key === key)) ? bundle.key : "generic";
  const additional = form === "generic" ? record.fields : record.fields.filter(({ key }) => !covered.includes(key));
  return { root, schemas, form, additionalFields: additional.flatMap(({ key, schema }) => {
    const declared = schemas.get(schema);
    const shape = declared?.kind === "optional" ? schemas.get(declared.item) : declared;
    return shape ? [{ key, schema, shape, optional: declared?.kind === "optional" }] : [];
  }) };
}

interface WorkflowLaunchDraft {
  readonly fields: LaunchInputDraft;
  readonly epic: EpicLaunchDraft;
  readonly studySlice: StudySliceDraft;
}

export function selectWorkflowLaunchInput(schema: LaunchInputSchema, draft: WorkflowLaunchDraft):
  Result<Readonly<Record<string, unknown>>, LaunchInputRefusal> {
  const values: [string, unknown][] = [];
  if (schema.form !== "generic") {
    const epic = selectEpicInput(draft.epic);
    if (!epic.ok) return epic;
    values.push(...Object.entries(epic.value));
  }
  if (schema.form === "study") {
    const slice = selectStudySliceLimits(draft.studySlice);
    if (!slice.ok) return slice;
    values.push(...Object.entries(slice.value));
  }
  for (const field of schema.additionalFields) {
    const raw = Object.hasOwn(draft.fields, field.key) ? draft.fields[field.key] : "";
    if (field.optional && raw.trim() === "") {
      if (schema.form === "study" && field.key === "approved_plan") values.push([field.key, null]);
      continue;
    }
    let value: unknown = raw;
    switch (field.shape.kind) {
      case "record": case "list":
        try { value = JSON.parse(raw); }
        catch { return { ok: false, error: { detail: `${field.key} must contain valid JSON.` } }; }
        break;
      case "integer": value = /^-?\d+$/.test(raw) ? Number(raw) : null; break;
      case "boolean": value = raw === "true" ? true : raw === "false" ? false : null; break;
    }
    if (!matchesProjectedSchema(schema.schemas, field.schema, value))
      return { ok: false, error: { detail: `${field.key} does not match ${field.schema}.` } };
    values.push([field.key, value]);
  }
  const input = Object.fromEntries(values);
  return matchesProjectedSchema(schema.schemas, schema.root, input)
    ? { ok: true, value: input }
    : { ok: false, error: { detail: "Input does not match the workflow's launch schema." } };
}

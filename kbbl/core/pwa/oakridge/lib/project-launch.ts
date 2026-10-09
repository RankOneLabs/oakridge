import type { OperatorProjectView, OperatorSchema } from "../operator-contracts";
import type { InputField } from "./operator-input";

/** The JSON a launch field receives from a project, keyed by root input field. */
export type ProjectLaunchDrafts = Readonly<{ readonly [field_key: string]: string }>;
type Draftable = string | null | readonly Draftable[] | { readonly [key: string]: Draftable };

/**
 * A project's checkout fills the definition's input wherever the schema names
 * one of its facts: paths and workdirs get the repo directory, forge owner and
 * name come from the project's repository, base branches from its integration
 * branch, and a session is named after the project and its role. A string the
 * project cannot answer (the spec) is left for the operator.
 */
function valueFor(project: OperatorProjectView, schemas: readonly OperatorSchema[], schema_key: string, field_key: string, role: string): Draftable | undefined {
  const shape = schemas.find((schema) => schema.key === schema_key)?.shape;
  if (!shape) return undefined;
  switch (shape.kind) {
    case "optional": return null;
    case "enum": return shape.variants[0];
    case "list": {
      const item = valueFor(project, schemas, shape.item, field_key, role);
      return item === undefined ? undefined : [item];
    }
    case "record": {
      const record: { [key: string]: Draftable } = {};
      for (const field of shape.fields) {
        const value = valueFor(project, schemas, field.schema, field.key, field.key === "key" ? role : shape.fields.some((item) => item.key === "workdir") ? role : field.key);
        if (value === undefined) return undefined;
        record[field.key] = value;
      }
      return record;
    }
    case "string": {
      const branch = project.integration_branch ?? "main";
      const answers: { readonly [key: string]: string | undefined } = {
        repository_path: project.repo_dir, workdir: project.repo_dir, repo_dir: project.repo_dir,
        key: project.name, owner: project.forge_repository?.owner, name: project.forge_repository?.name,
        build_base: branch, final_base: branch, session_name: `${project.name}-${role}`,
      };
      return answers[field_key];
    }
    default: return undefined;
  }
}

/** Launch drafts for every structured root field the project can fill completely. */
export function selectProjectLaunchDrafts(project: OperatorProjectView, fields: readonly InputField[], schemas: readonly OperatorSchema[]): ProjectLaunchDrafts {
  const drafts: { [field_key: string]: string } = {};
  for (const { field, schema } of fields) {
    if (!schema || schema.shape.kind === "string" || schema.shape.kind === "integer" || schema.shape.kind === "boolean") continue;
    const value = valueFor(project, schemas, field.schema, field.key, field.key);
    if (value !== undefined) drafts[field.key] = JSON.stringify(value, null, 2);
  }
  return drafts;
}

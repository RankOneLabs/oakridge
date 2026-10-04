import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { WorkflowDefinition, PromptBundle, PromptBundleEntry } from "../domain/workflow";
import type { ArtifactRef, PreparedImplementationRepository } from "../domain/dev-flow-v15";
import type { JsonValue } from "../domain/primitives";

export interface PromptTemplateLoader {
  load(path: string): Promise<string>;
}

export const createPromptTemplateLoader = (root: string): PromptTemplateLoader => {
  const resolvedRoot = resolve(root);
  return {
    async load(path: string): Promise<string> {
      const resolvedPath = resolve(resolvedRoot, path);
      const relativePath = relative(resolvedRoot, resolvedPath);
      const isOutsideRoot =
        relativePath === "" ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath);
      if (isOutsideRoot) {
        throw new Error(`prompt template '${path}' is outside the configured prompt root`);
      }
      return readFile(resolvedPath, "utf8");
    },
  };
};

/** Load and content-address the complete role × launch-reason matrix. */
export const createPromptBundle = async (definition: WorkflowDefinition, loader: PromptTemplateLoader): Promise<PromptBundle> => {
  const unique = new Map<string, PromptBundleEntry>();
  for (const [stageKey, stage] of Object.entries(definition.graph.stages)) {
    if (stage.stage_type !== "delegated_session") continue;
    const config = stage.config as { readonly prompt_matrix?: readonly Omit<PromptBundleEntry, "content">[] };
    for (const entry of config.prompt_matrix ?? []) {
      const content = await loader.load(entry.template_path);
      unique.set(`${stageKey}:${entry.session_role}:${entry.launch_reason}:${entry.template_path}`, { ...entry, stage_key: stageKey, content });
    }
  }
  const matrix = [...unique.values()].sort((left, right) =>
    `${left.stage_key ?? ""}:${left.session_role}:${left.launch_reason}:${left.template_path}`
      .localeCompare(`${right.stage_key ?? ""}:${right.session_role}:${right.launch_reason}:${right.template_path}`));
  const hash = createHash("sha256").update(JSON.stringify(matrix)).digest("hex");
  return { version: 1, hash, matrix };
};

export interface ReferencedActionArtifact {
  readonly ref: ArtifactRef;
  readonly artifact_type: string;
  readonly body: JsonValue;
  readonly revision_context?: JsonValue;
}

export interface ActionPromptInput {
  readonly template: string;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly artifacts: readonly ReferencedActionArtifact[];
  readonly execution: { readonly worker: string; readonly action_point: string; readonly cohort_id: string };
  readonly repository: PreparedImplementationRepository | null;
}

/** Render only the selected action's fields and the exact immutable revisions they reference. */
export const renderActionPrompt = (input: ActionPromptInput): string => {
  const rendered_artifacts = new Set<string>();
  const sections = Object.entries(input.fields).map(([name, value]) => {
    const references = input.artifacts.filter((artifact) => {
      const contains = (candidate: JsonValue): boolean => {
        if (Array.isArray(candidate)) return candidate.some(contains);
        if (candidate === null || typeof candidate !== "object") return false;
        const object = candidate as Readonly<Record<string, JsonValue>>;
        if (object.id === artifact.ref.id && object.version === artifact.ref.version) return true;
        return Object.values(object).some(contains);
      };
      return contains(value);
    });
    const assessment = name === "feedback" && typeof value === "object" && value !== null && !Array.isArray(value)
      && (value as Readonly<Record<string, JsonValue>>).source === "assessment"
      ? references.find((artifact) => artifact.revision_context !== undefined) : null;
    const context = assessment?.revision_context ?? null;
    const first_references = references.filter((artifact) => {
      const key = `${artifact.ref.id}@${artifact.ref.version}`;
      if (rendered_artifacts.has(key)) return false;
      rendered_artifacts.add(key);
      return true;
    });
    return `## ${name}\n${JSON.stringify(value, null, 2)}${context
      ? `\n\n### Assessment revision context\n${JSON.stringify(context, null, 2)}` : ""}${first_references.map((artifact) =>
      `\n\n### Referenced ${artifact.artifact_type} ${artifact.ref.id}@${artifact.ref.version}\n${JSON.stringify(artifact.body, null, 2)}`).join("")}`;
  });
  const repository = input.repository;
  return [input.template.trimEnd(), ...sections,
    `## Execution contract\nWorker: ${input.execution.worker}\nAction: ${input.execution.action_point}\nCohort: ${input.execution.cohort_id}${repository
      ? `\nWorktree: ${repository.worktree_path}\nWorktree base: ${repository.worktree_base_sha}\nCanonical cohort ref: ${repository.canonical_branch}\nPull request base: ${repository.expected_pr_base}` : ""}`,
  ].join("\n\n");
};

import type { JsonValue } from "../../domain/primitives";
import type { EvidenceReference, LineRange, NotReadyReason, RepositoryEvidence } from "../../grading/evidence";
import { valueAtPointer } from "../../grading/evidence";
import { z } from "zod";
import type { CapturedRevision, CapturedSources, EvidenceCollection, LinkedItem, RepositoryFile, SourceArtifact } from "../../ports/artifact-source";
import type { EvidenceCapabilities, EvidenceCapability, EvidenceResolutionContext } from "../../ports/producer-profile";
type JsonObject = { readonly [key: string]: JsonValue };
const objectOf = (value: JsonValue | undefined): JsonObject | null =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;

export const notReady = (code: string, detail: string): Extract<EvidenceCollection, { state: "not_ready" }> =>
  ({ state: "not_ready", reason: { code, detail } satisfies NotReadyReason });
const ready = (references: readonly EvidenceReference[]): EvidenceCollection => ({ state: "ready", references });

/** A citation mirrors the assessment artifact's evidence entries; `index` is its position in the finding's list. */
export interface Citation { readonly index: number; readonly kind: "file" | "test" | "output"; readonly ref: string; readonly detail: string | null }
export interface FileAddress { readonly path: string; readonly line_range: LineRange | null }

/** `core/decision-record.ts:18-31`, a line, or a bare path. Anything else stays as text. */
export function parseFileCitation(ref: string): FileAddress | null {
  const match = /^([^\s:]+)(?::(\d+)(?:-(\d+))?)?$/.exec(ref);
  if (!match?.[1]) return null;
  const start = match[2] ? Number(match[2]) : null;
  const end = match[3] ? Number(match[3]) : start;
  if (start !== null && (start < 1 || end === null || end < start)) return null;
  return { path: match[1], line_range: start === null || end === null ? null : { start, end } };
}

export function citationsOf(finding: JsonValue): readonly Citation[] {
  const entries = objectOf(finding)?.evidence;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: JsonValue, index): Citation[] => {
    const fields = objectOf(entry);
    if (!fields || typeof fields.ref !== "string") return [];
    if (fields.kind !== "file" && fields.kind !== "test" && fields.kind !== "output") return [];
    return [{ index, kind: fields.kind, ref: fields.ref, detail: typeof fields.detail === "string" ? fields.detail : null }];
  });
}

/** A citation passed through as the agent wrote it, at its exact place in the finding. */
function reported(ref: string, citation: Citation, artifact: SourceArtifact): EvidenceReference {
  return { source: "reported", reported_by: "agent", ref, revision_id: artifact.revision_id,
    item_path: `${artifact.item_path}/evidence/${citation.index}`,
    content: { kind: citation.kind, citation: citation.ref, detail: citation.detail } };
}

/** The assessment's own test results, as its agent reported them. Absent results are no wait. */
export function testEvidence(revision: CapturedRevision): readonly EvidenceReference[] {
  const results = objectOf(objectOf(revision.body)?.test_evidence);
  return results ? [{ source: "reported", reported_by: "agent", ref: "test_evidence", revision_id: revision.revision_id,
    item_path: "/test_evidence", content: results }] : [];
}
function lines(content: string, range: LineRange | null): string {
  return range ? content.split("\n").slice(range.start - 1, range.end).join("\n") : content;
}

type LocatedFile = Omit<RepositoryEvidence, "content" | "is_absent" | "is_binary" | "byte_size">;
/** A file read at its commit as evidence: cited lines of text, the size of a binary file, or its absence. */
function repositoryReference(located: LocatedFile, file: Exclude<RepositoryFile, { readonly state: "unavailable" }>): RepositoryEvidence {
  switch (file.state) {
    case "present": return { ...located, is_absent: false, is_binary: false, byte_size: null, content: lines(file.content, located.line_range) };
    case "binary": return { ...located, is_absent: false, is_binary: true, byte_size: file.byte_size, content: null };
    case "absent": return { ...located, is_absent: true, is_binary: false, byte_size: null, content: null };
  }
}

interface RepositoryChoice { readonly repository_key: string; readonly repository_path: string }
/** The launch input's repositories, as the workflow declares them. */
function launchRepositories(input: JsonValue | null): readonly RepositoryChoice[] {
  const repositories = objectOf(input ?? null)?.repositories;
  if (!Array.isArray(repositories)) return [];
  return repositories.flatMap((entry: JsonValue): RepositoryChoice[] => {
    const repository = objectOf(entry);
    const path = objectOf(repository?.preparation)?.repository_path;
    return typeof repository?.key === "string" && typeof path === "string"
      ? [{ repository_key: repository.key, repository_path: path }] : [];
  });
}

async function repositoryAt(sources: CapturedSources, commit_sha: string): Promise<RepositoryChoice | null> {
  for (const repository of launchRepositories(await sources.readRunInput()))
    if (await sources.repository.hasCommit(repository.repository_path, commit_sha)) return repository;
  return null;
}

type CitationEvidence = { readonly references: readonly EvidenceReference[] } | { readonly waiting: EvidenceCollection };

/** Read every citation. Only a required file lookup that cannot run makes the question wait:
 * an absent file, unparseable ref or empty citation list is itself evidence. */
async function citationEvidence(artifact: SourceArtifact, revision: CapturedRevision, sources: CapturedSources): Promise<CitationEvidence> {
  const citations = citationsOf(artifact.selected_value);
  const parsed = citations.map((citation) => ({ citation, address: citation.kind === "file" ? parseFileCitation(citation.ref) : null }));
  if (!parsed.some(({ address }) => address)) return { references: citations.map((citation, index) => reported(`citation:${index}`, citation, artifact)) };
  const head_sha = objectOf(revision.body)?.head_sha;
  if (typeof head_sha !== "string" || head_sha.length === 0)
    return { waiting: notReady("commit_unavailable", `revision ${revision.revision_id} names no head_sha for its file citations`) };
  const repository = await repositoryAt(sources, head_sha);
  if (!repository) return { waiting: notReady("repository_unavailable", `no launch repository holds commit ${head_sha}`) };
  const references: EvidenceReference[] = [];
  for (const [index, { citation, address }] of parsed.entries()) {
    const ref = `citation:${index}`;
    if (!address) { references.push(reported(ref, citation, artifact)); continue; }
    const file = await sources.repository.readFile({ repository_path: repository.repository_path, commit_sha: head_sha, path: address.path });
    if (file.state === "unavailable") return { waiting: notReady("repository_unavailable", file.detail) };
    references.push(repositoryReference({ source: "repository", ref, repository_key: repository.repository_key,
      commit_sha: head_sha, path: address.path, line_range: address.line_range }, file));
  }
  return { references };
}

const subjectReference = (artifact: SourceArtifact): EvidenceReference => ({ source: "revision", ref: "subject",
  revision_id: artifact.revision_id, item_path: artifact.item_path, content: artifact.selected_value });
const contextReference = (item: LinkedItem, index: number): EvidenceReference => ({ source: "revision", ref: `task_context:${index}`,
  revision_id: item.revision_id, item_path: item.item_path, content: item.selected_value });


/** Source coordinates are supplied by definitions, independent of question and artifact names. */
const sourceSchema = z.strictObject({ artifact: z.string().min(1), list: z.string().regex(/^\/(?:[^~]|~[01])*$/) });
type DefinitionSource = z.infer<typeof sourceSchema>;
interface LocatedDefinition { readonly value: JsonObject; readonly item_path: string }
interface DefinitionLookup { readonly revision: CapturedRevision; readonly source: DefinitionSource; readonly id: string }
function definitionAt({ revision, source, id }: DefinitionLookup): LocatedDefinition | null {
  const entries = valueAtPointer(revision.body, source.list);
  if (!Array.isArray(entries)) return null;
  const index = entries.findIndex((entry) => objectOf(entry)?.id === id);
  const value = index < 0 ? null : objectOf(entries[index]);
  return value ? { value, item_path: `${source.list}/${index}` } : null;
}
const revisionReference = (ref: string, revision: CapturedRevision, item_path: string | null, content: JsonValue): EvidenceReference =>
  ({ source: "revision", ref, revision_id: revision.revision_id, item_path, content });

type TaskDefinition = { readonly state: "ready"; readonly revision: CapturedRevision; readonly task: LocatedDefinition }
  | Extract<EvidenceCollection, { state: "not_ready" }>;
async function taskDefinition({ artifact, sources }: EvidenceResolutionContext, source: DefinitionSource): Promise<TaskDefinition> {
  const id = objectOf(artifact.selected_value)?.id;
  if (typeof id !== "string") return notReady("task_unavailable", "the item names no spec task id");
  const revision = await sources.readRevisionAt(source.artifact, artifact.revision_id);
  if (!revision) return notReady("task_unavailable", `no task list is captured at ${artifact.revision_id}`);
  const task = definitionAt({ revision, source, id });
  return task ? { state: "ready", revision, task } : notReady("task_unavailable", `task ${id} is absent from ${revision.revision_id}`);
}

/** Type erasure stays at the registry boundary; schemas supply the resolver's actual parameter type. */
interface CapabilityDefinition<Params> {
  readonly params: z.ZodType<Params>;
  readonly subject: EvidenceCapability["subject"];
  readonly resolve: (context: EvidenceResolutionContext, params: Params) => Promise<EvidenceCollection>;
}
function capability<Params>({ params, subject, resolve }: CapabilityDefinition<Params>): EvidenceCapability {
  return { params, subject, async resolve(context, raw) {
    const parsed = params.safeParse(raw);
    return parsed.success ? resolve(context, parsed.data) : notReady("invalid_capability_params", parsed.error.message);
  } };
}
const noParams = z.strictObject({});
const anySubject = { fields: [], task_subject: false } as const;
const idSubject = { fields: ["/id"], task_subject: false } as const;
const citedSubject = { fields: ["/evidence"], task_subject: false } as const;

/** Names and parameter schemas are the producer's only evidence registrations. */
export const oakridgeCapabilities: EvidenceCapabilities = {
  build_item_context: capability({ params: noParams, subject: { fields: ["/task_ids"], task_subject: true }, resolve: async ({ artifact, question, sources }) => {
    const brief = await sources.readRevision(artifact.revision_id);
    if (!brief || brief.artifact_kind !== "brief") return notReady("brief_unavailable", "the containing brief is not captured");
    const cohort_id = objectOf(brief.body)?.cohort_id;
    if (typeof cohort_id !== "string") return notReady("brief_unavailable", "brief has no cohort id");
    if (question.task_id === null) return notReady("task_unavailable", "build item needs a linked task");
    const task = await sources.readLogicalItemAt({ logical_item_id: question.task_id, subject_revision_id: artifact.revision_id, artifact_kind: "tasks", item_kind: "task", allow_late_reference: true });
    if (!task) return notReady("task_unavailable", "linked canonical task is not captured");
    const plan = await sources.readRevisionAt("plan", brief.revision_id);
    const cohorts = plan && objectOf(plan.body)?.cohorts;
    const index = Array.isArray(cohorts) ? cohorts.findIndex((entry) => objectOf(entry)?.id === cohort_id) : -1;
    if (!plan || !Array.isArray(cohorts) || index < 0) return notReady("cohort_unavailable", "plan cohort is not captured");
    const spec = await oakridgeCapabilities.spec!.resolve({ artifact: { ...artifact, revision_id: task.revision_id }, question, sources }, { artifact: "spec" });
    if (spec.state === "not_ready") return spec;
    const references: EvidenceReference[] = [subjectReference(artifact), contextReference(task, 0),
      revisionReference("brief", brief, null, brief.body), revisionReference("cohort", plan, `/cohorts/${index}`, cohorts[index]!), ...spec.references];
    const ids = objectOf(task.selected_value)?.requirement_ids;
    if (Array.isArray(ids) && ids.length > 0) {
      const analysis = await sources.readRevisionAt("analysis", task.revision_id);
      if (!analysis) return notReady("requirements_unavailable", "task requirement context is not captured");
      for (const [index, id] of ids.entries()) {
        if (typeof id !== "string") return notReady("requirements_unavailable", "invalid requirement id");
        const requirement = definitionAt({ revision: analysis, source: { artifact: "analysis", list: "/requirements" }, id });
        if (!requirement) return notReady("requirements_unavailable", `requirement ${id} is not captured`);
        references.push(revisionReference(`requirement:${index}`, analysis, requirement.item_path, requirement.value));
      }
    }
    return ready(references);
  } }),
  assessed_build_items: capability({ params: noParams, subject: anySubject, resolve: async ({ artifact, sources }) => {
    // Legacy findings have no build-item subjects and retain their original evidence.
    const subjects = objectOf(artifact.selected_value)?.subjects;
    if (!Array.isArray(subjects)) return ready([]);
    const expected = subjects.filter((subject) => objectOf(subject)?.kind === "build_item");
    if (expected.length === 0) return ready([]);
    const revision = await sources.readRevision(artifact.revision_id);
    if (revision?.brief_revision_ids == null) return notReady("brief_provenance_unresolved", "recorded brief revisions are unavailable");
    const items = (await sources.readLinkedItems(artifact.occurrence_id)).filter((item) => item.item_kind === "build_item" && revision.brief_revision_ids!.includes(item.revision_id));
    for (const subject of expected) {
      const value = objectOf(subject)!;
      let matched = false;
      for (const item of items) {
        if (objectOf(item.selected_value)?.id !== value.id) continue;
        if (typeof value.cohort_id === "string") {
          const brief = await sources.readRevision(item.revision_id);
          if (objectOf(brief?.body)?.cohort_id !== value.cohort_id) continue;
        }
        matched = true;
      }
      if (!matched) return notReady("build_item_unresolved", "an assessed build item is unresolved in the recorded brief");
    }
    return ready(items.map((item, index) => ({ source: "revision", ref: `assessed_build_item:${index}`,
      revision_id: item.revision_id, item_path: item.item_path, content: item.selected_value })));
  } }),
  subject: capability({ params: noParams, subject: anySubject, resolve: async ({ artifact }) => ready([subjectReference(artifact)]) }),
  spec: capability({ params: z.strictObject({ artifact: z.string().min(1).optional(), task_source: sourceSchema.optional() }), subject: anySubject, resolve: async ({ artifact, sources }, params) => {
      let anchor = artifact.revision_id;
      if (params.task_source) {
        const taskRevision = await sources.readRevisionAt(params.task_source.artifact, artifact.revision_id);
        if (!taskRevision) return notReady("task_unavailable", `no task list is captured at ${artifact.revision_id}`);
        anchor = taskRevision.revision_id;
      }
      const revision = params.artifact ? await sources.readRevisionAt(params.artifact, anchor) : null;
      if (revision) return ready([revisionReference("spec", revision, null, revision.body)]);
      const spec = objectOf(await sources.readRunInput())?.spec;
      return typeof spec === "string" && spec.length > 0
        ? ready([{ source: "run_input", ref: "spec", run_id: artifact.run_id, input_path: "/spec", content: spec }])
        : notReady("spec_unavailable", `run ${artifact.run_id} has no captured launch spec`);
    } }),
  build_result: capability({ params: noParams, subject: anySubject, resolve: async ({ artifact, sources }) => {
    const revision = await sources.readRevision(artifact.revision_id);
    if (!revision) return notReady("revision_unavailable", `revision ${artifact.revision_id} is not captured`);
    if (!revision.subject_id) return ready([]);
    const build = await sources.readRevision(revision.subject_id);
    return build ? ready([revisionReference("build_result", build, null, build.body)])
      : notReady("build_result_unavailable", `build result ${revision.subject_id} is not captured`);
  } }),
  citation: capability({ params: noParams, subject: citedSubject, resolve: async ({ artifact, sources }) => {
    const revision = await sources.readRevision(artifact.revision_id);
    if (!revision) return notReady("revision_unavailable", `revision ${artifact.revision_id} is not captured`);
    const result = await citationEvidence(artifact, revision, sources);
    return "waiting" in result ? result.waiting : ready(result.references);
  } }),
  test_evidence: capability({ params: noParams, subject: anySubject, resolve: async ({ artifact, sources }) => {
    const revision = await sources.readRevision(artifact.revision_id);
    return revision ? ready(testEvidence(revision)) : notReady("revision_unavailable", `revision ${artifact.revision_id} is not captured`);
  } }),
  task_context: capability({ params: z.strictObject({ artifact: z.string().min(1), item_kind: z.string().min(1) }), subject: { fields: [], task_subject: true }, resolve: async ({ artifact, question, sources }, params) => {
      if (question.task_id === null) return ready([]);
      const task = await sources.readLogicalItemAt({ logical_item_id: question.task_id, subject_revision_id: artifact.revision_id,
        artifact_kind: params.artifact, item_kind: params.item_kind, allow_late_reference: true });
      return task ? ready([contextReference(task, 0)])
        : notReady("task_unavailable", `task ${question.task_id} has no captured spec-task definition at ${artifact.revision_id}`);
    } }),
  spec_task: capability({ params: sourceSchema, subject: idSubject, resolve: async (context, params) => {
    const task = await taskDefinition(context, params);
    return task.state === "not_ready" ? task : ready([revisionReference("spec_task", task.revision, task.task.item_path, task.task.value)]);
  } }),
  requirement: capability({ params: z.strictObject({ ...sourceSchema.shape, task_source: sourceSchema }), subject: idSubject, resolve: async (context, params) => {
    const task = await taskDefinition(context, params.task_source);
    if (task.state === "not_ready") return task;
    const ids = task.task.value.requirement_ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
      return notReady("requirements_unavailable", "task has no valid requirement_ids");
    if (ids.length === 0) return ready([]);
    const revision = await context.sources.readRevisionAt(params.artifact, context.artifact.revision_id);
    if (!revision) return notReady("requirements_unavailable", `no ${params.artifact} is captured at ${context.artifact.revision_id}`);
    const references: EvidenceReference[] = [];
    for (const [index, id] of [...new Set(ids)].entries()) {
      const requirement = definitionAt({ revision, source: params, id });
      if (!requirement) return notReady("requirements_unavailable", `requirement ${id} is absent from ${revision.revision_id}`);
      references.push(revisionReference(`requirement:${index}`, revision, requirement.item_path, requirement.value));
    }
    return ready(references);
  } }),
  plan: capability({ params: z.strictObject({ artifact: z.string().min(1) }), subject: anySubject, resolve: async ({ artifact, sources }, params) => {
    const plan = await sources.readRevisionAt(params.artifact, artifact.revision_id);
    return plan ? ready([revisionReference("plan", plan, null, plan.body)])
      : notReady("plan_unavailable", `no ${params.artifact} is captured at ${artifact.revision_id}`);
  } }),
  contribution_context: capability({ params: noParams, subject: anySubject, resolve: async ({ artifact, sources }) => {
    const revision = await sources.readRevision(artifact.revision_id);
    if (!revision) return notReady("revision_unavailable", `revision ${artifact.revision_id} is not captured`);
    // Remove the list index and the list field: the containing object may be the revision itself.
    const path = artifact.item_path.split("/").slice(0, -2).join("/");
    const content = valueAtPointer(revision.body, path);
    return content === undefined ? notReady("cohort_unavailable", `container at ${path} is absent`)
      : ready([revisionReference("contribution_context", revision, path || null, content)]);
  } }),
};

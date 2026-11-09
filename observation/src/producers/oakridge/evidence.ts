import type { JsonValue } from "../../domain/primitives";
import type { EvidenceReference, LineRange, NotReadyReason, RepositoryEvidence } from "../../grading/evidence";
import type { QuestionKey } from "../../grading/question";
import type { CapturedRevision, CapturedSources, EvidenceCollection, LinkedItem, SourceArtifact } from "../../ports/artifact-source";
import type { EvidenceCollector } from "../../ports/producer-profile";
import { CORRECTNESS_ID, EVIDENCE_SUPPORT_ID, RELEVANCE_ID } from "./questions";

type JsonObject = { readonly [key: string]: JsonValue };
const objectOf = (value: JsonValue | undefined): JsonObject | null =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;

export const notReady = (code: string, detail: string): EvidenceCollection =>
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
    const located: Omit<RepositoryEvidence, "content" | "is_absent"> = { source: "repository", ref,
      repository_key: repository.repository_key, commit_sha: head_sha, path: address.path, line_range: address.line_range };
    references.push(file.state === "absent" ? { ...located, is_absent: true, content: null }
      : { ...located, is_absent: false, content: lines(file.content, address.line_range) });
  }
  return { references };
}

const subjectReference = (artifact: SourceArtifact): EvidenceReference => ({ source: "revision", ref: "subject",
  revision_id: artifact.revision_id, item_path: artifact.item_path, content: artifact.selected_value });
const contextReference = (item: LinkedItem, index: number): EvidenceReference => ({ source: "revision", ref: `task_context:${index}`,
  revision_id: item.revision_id, item_path: item.item_path, content: item.selected_value });

async function relevance(artifact: SourceArtifact, sources: CapturedSources): Promise<EvidenceCollection> {
  const spec = objectOf(await sources.readRunInput())?.spec;
  if (typeof spec !== "string" || spec.length === 0) return notReady("spec_unavailable", `run ${artifact.run_id} has no captured launch spec`);
  return ready([subjectReference(artifact),
    { source: "run_input", ref: "spec", run_id: artifact.run_id, input_path: "/spec", content: spec }]);
}

async function citedEvidence(artifact: SourceArtifact, sources: CapturedSources)
  : Promise<{ readonly revision: CapturedRevision; readonly evidence: CitationEvidence } | EvidenceCollection> {
  const revision = await sources.readRevision(artifact.revision_id);
  if (!revision) return notReady("revision_unavailable", `revision ${artifact.revision_id} is not captured`);
  const evidence = await citationEvidence(artifact, revision, sources);
  return { revision, evidence: "waiting" in evidence ? evidence : { references: [...evidence.references, ...testEvidence(revision)] } };
}

async function evidenceSupport(artifact: SourceArtifact, sources: CapturedSources): Promise<EvidenceCollection> {
  const cited = await citedEvidence(artifact, sources);
  if ("state" in cited) return cited;
  if ("waiting" in cited.evidence) return cited.evidence.waiting;
  return ready([subjectReference(artifact), ...cited.evidence.references]);
}

async function correctness(artifact: SourceArtifact, sources: CapturedSources): Promise<EvidenceCollection> {
  const cited = await citedEvidence(artifact, sources);
  if ("state" in cited) return cited;
  if ("waiting" in cited.evidence) return cited.evidence.waiting;
  const { subject_id } = cited.revision;
  // An integration assessment names no build, and that absence alone is not a wait.
  const build = subject_id ? await sources.readRevision(subject_id) : null;
  if (subject_id && !build) return notReady("build_result_unavailable", `build result ${subject_id} is not captured`);
  const context = await sources.readLinkedItems(artifact.occurrence_id);
  return ready([subjectReference(artifact),
    ...(build ? [{ source: "revision", ref: "build_result", revision_id: build.revision_id, item_path: null, content: build.body } as const] : []),
    ...cited.evidence.references, ...context.map(contextReference)]);
}

/** Each question is collected on its own, so one waiting lookup never delays another question. */
export const oakridgeEvidence: EvidenceCollector = {
  collect(artifact: SourceArtifact, question: QuestionKey, sources: CapturedSources): Promise<EvidenceCollection> {
    if (question.question_id === RELEVANCE_ID) return relevance(artifact, sources);
    if (question.question_id === CORRECTNESS_ID) return correctness(artifact, sources);
    if (question.question_id === EVIDENCE_SUPPORT_ID) return evidenceSupport(artifact, sources);
    return Promise.resolve(notReady("unsupported_question", `question ${question.question_id} has no evidence rule`));
  },
};

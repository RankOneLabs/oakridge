import { z } from "zod";
import { artifactAddressToObservationRevision, resolveOccurrence,
  type ArtifactAddress, type Result, type Resolution } from "./revision-address";
import { gradeSlot, type ArtifactItemSummary, type EligibilityView, type GradeObservationView } from "./view-model";

// Mirrors GET /v1/runs/:run_id/items, /v1/items/:id/eligibility and /grades.
const occurrenceSchema = z.object({ occurrence_id: z.string(), revision_id: z.string(),
  item_id_or_path: z.string(), item_kind: z.string(), selected_value: z.unknown() });
const itemsPageSchema = z.object({ items: z.array(occurrenceSchema), total: z.number() });
const eligibilitySchema = z.object({ tag: z.string(), question_id: z.string(),
  question_version: z.string(), payload: z.unknown() });
const eligibilityPageSchema = z.object({ items: z.array(eligibilitySchema) });
const gradeSchema = z.object({ observation: z.object({ observation_id: z.string(),
  evaluator_definition_id: z.string(), label_origin: z.string() }),
  answer: z.object({ state: z.string(), kind: z.string(), value: z.unknown().optional(), reason: z.string().optional() }) });
export const gradesPageSchema = z.object({ items: z.array(gradeSchema), total: z.number() });
export const lineageSchema = z.object({ occurrence_id: z.string(), relations: z.array(z.object({
  relation_id: z.string(), type: z.string(), source_occurrence_id: z.string().nullable(),
  target_occurrence_id: z.string().nullable(), unresolved_target_ref: z.string().nullable() })),
  unresolved: z.array(z.object({ relation_id: z.string(), unresolved_target_ref: z.string().nullable() })),
  total: z.number() });
const evidenceSchema = z.object({ evidence_set_id: z.string(), evidence_refs: z.array(z.object({
  ref: z.string(), kind: z.string().optional(), digest: z.string().nullable(),
  deep_link: z.string().nullable(), content: z.unknown().optional() })),
  is_incomplete: z.boolean(), digest: z.string() });
const blindAssignmentViewSchema = z.object({ assignment_id: z.string(), state: z.enum(["unsubmitted", "claimed", "expired", "submitted"]),
  subject_occurrence_id: z.string(), evidence_set_id: z.string(), question_id: z.string(),
  question_version: z.string(), question_text: z.string().nullable() });
const blindAssignmentSchema = blindAssignmentViewSchema.extend({ blinded_evidence: z.unknown() });

export type ObservationItemsPage = z.infer<typeof itemsPageSchema>;
export type ObservationEligibilityPage = z.infer<typeof eligibilityPageSchema>;
export type ObservationGradesPage = z.infer<typeof gradesPageSchema>;
export type ObservationLineage = z.infer<typeof lineageSchema>;
export type ObservationEvidence = z.infer<typeof evidenceSchema>;
export type ObservationBlindAssignment = z.infer<typeof blindAssignmentSchema>;
export type ObservationBlindAssignmentList = { readonly items: readonly z.infer<typeof blindAssignmentViewSchema>[] };

export interface ObservationConfig { readonly base_url: string; readonly namespace: string;
  readonly read_token: string; readonly grade_token: string }
export interface SummaryAddress { readonly artifact: ArtifactAddress; readonly item_id_or_path: string }
type Parser<T> = { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { message: string } } };
type Fetcher = (input: Request | URL | string, init?: RequestInit) => Promise<Response>;

export function observationConfigFromEnv(env: NodeJS.ProcessEnv): ObservationConfig | null {
  const base_url = env.OAKRIDGE_OBSERVATION_URL?.trim();
  const namespace = env.OAKRIDGE_OBSERVATION_NAMESPACE?.trim();
  const read_token = env.OAKRIDGE_OBSERVATION_READ_TOKEN?.trim();
  const grade_token = env.OAKRIDGE_OBSERVATION_GRADE_TOKEN?.trim();
  if (!base_url && !read_token && !grade_token) return null;
  if (!base_url || !namespace || !read_token || !grade_token)
    throw new Error("kbbl observation: URL, namespace, read token and grade token must be configured together");
  const parsed = URL.canParse(base_url) ? new URL(base_url) : null;
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || read_token === grade_token)
    throw new Error("kbbl observation: invalid URL or duplicate capability tokens");
  return { base_url, namespace, read_token, grade_token };
}

export function createObservationClient(config: ObservationConfig, fetcher: Fetcher = fetch) {
  async function read<T>(operation: string, entity_id: string, path: string, parser: Parser<T>,
    capability: "read" | "grade" = "read", method = "GET", body?: unknown): Promise<Result<T>> {
    try {
      const response = await fetcher(new URL(path, `${config.base_url.replace(/\/$/, "")}/`), {
        method, headers: { authorization: `Bearer ${capability === "read" ? config.read_token : config.grade_token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: "no-store" });
      if (!response.ok) return { ok: false, error: { operation, entity_id,
        detail: `observation HTTP ${response.status}` } };
      const parsed = parser.safeParse(await response.json());
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false,
        error: { operation, entity_id, detail: "malformed observation response" } };
    } catch {
      return { ok: false, error: { operation, entity_id, detail: "observation network or parse failure" } };
    }
  }
  async function resolve(address: SummaryAddress): Promise<Result<{ resolution: Resolution; items: ObservationItemsPage["items"] }>> {
    const revision = artifactAddressToObservationRevision(address.artifact);
    if (!revision.ok) return revision;
    const params = new URLSearchParams({ revision_id: revision.value,
      item_id_or_path: address.item_id_or_path, limit: "2" });
    const page = await read("resolve_occurrence", revision.value,
      `v1/runs/${encodeURIComponent(address.artifact.run_id)}/items?${params}`, itemsPageSchema);
    if (!page.ok) return page;
    const resolved = resolveOccurrence(revision.value, page.value.items.map((item) => item.occurrence_id));
    return resolved.ok ? { ok: true, value: { resolution: resolved.value, items: page.value.items } } : resolved;
  }
  async function getArtifactItemSummary(address: SummaryAddress): Promise<Result<ArtifactItemSummary>> {
    const found = await resolve(address);
    if (!found.ok) return found;
    const { resolution } = found.value;
    if (resolution.kind === "unresolved") return { ok: true, value: { resolution,
      grade: { tag: "not_ingested" }, eligibility: [] } };
    const id = encodeURIComponent(resolution.occurrence_id);
    const eligibility = await read("read_eligibility", resolution.occurrence_id,
      `v1/items/${id}/eligibility`, eligibilityPageSchema);
    if (!eligibility.ok) return eligibility;
    const grades = await read("read_grades", resolution.occurrence_id,
      `v1/items/${id}/grades`, gradesPageSchema);
    if (!grades.ok) return grades;
    const observations: GradeObservationView[] = grades.value.items.map(({ observation, answer }) => ({
      observation_id: observation.observation_id,
      evaluator_definition_id: observation.evaluator_definition_id,
      label_origin: observation.label_origin, answer }));
    const eligibilityViews: EligibilityView[] = eligibility.value.items;
    const state = observations.length > 0 ? "ready"
      : eligibilityViews.some((item) => item.tag === "inapplicable") ? "inapplicable"
      : eligibilityViews.some((item) => item.tag === "missing_evidence" || item.tag === "invalid_reference") ? "missing_evidence"
      : eligibilityViews.some((item) => item.tag === "eligible") ? "loading" : "no_eligible_question";
    const slot = gradeSlot({ state, current_revision_id: resolution.revision_id,
      occurrence_revision_id: found.value.items[0]?.revision_id ?? resolution.revision_id, observations });
    return slot.ok ? { ok: true, value: { resolution, grade: slot.value,
      eligibility: eligibilityViews } } : slot;
  }
  const getLineage = (occurrence_id: string): Promise<Result<ObservationLineage>> => read("read_lineage", occurrence_id,
    `v1/items/${encodeURIComponent(occurrence_id)}/lineage`, lineageSchema);
  const getEvidence = (evidence_set_id: string): Promise<Result<ObservationEvidence>> => read("read_evidence", evidence_set_id,
    `v1/evidence-sets/${encodeURIComponent(evidence_set_id)}`, evidenceSchema);
  const listBlindAssignments = (): Promise<Result<ObservationBlindAssignmentList>> => read("list_blind_assignments", "blind-assignments",
    "v1/blind-assignments", z.object({ items: z.array(blindAssignmentViewSchema) }), "grade", "GET");
  const getBlindAssignment = (assignment_id: string): Promise<Result<ObservationBlindAssignment>> => read(
    "read_blind_assignment", assignment_id, `v1/blind-assignments/${encodeURIComponent(assignment_id)}`,
    blindAssignmentSchema, "grade", "GET");
  return { getArtifactItemSummary, getLineage, getEvidence, listBlindAssignments, getBlindAssignment };
}
export type ObservationClient = ReturnType<typeof createObservationClient>;

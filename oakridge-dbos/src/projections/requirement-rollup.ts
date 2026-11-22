import type { RunRead } from "../storage/read-store";

/** Integration judgments remain repository-local; pending is absence, never not_met. */
export type RepositoryRequirementJudgment =
  | { readonly repository_key: string; readonly status: "met" | "partial" | "not_met"; readonly revision_id: string; readonly head_sha: string }
  | { readonly repository_key: string; readonly status: "pending"; readonly revision_id: null; readonly head_sha: null };
export interface RequirementRollup {
  readonly requirement_id: string; readonly status: "pending" | "judged";
  readonly repositories: readonly RepositoryRequirementJudgment[];
}
/** Mirrors spec_body.requirements at the projection boundary. */
interface RollupSpec { readonly requirements: readonly { readonly id: string }[] }
/** Mirrors integration.input from development.yaml; briefs determine applicable requirements. */
interface IntegrationRequirementScope {
  readonly repository: { readonly key: string };
  readonly briefs: readonly { readonly build_items: readonly { readonly requirement_ids: readonly string[] }[] }[];
}
const object = (body: unknown): body is { readonly [key: string]: unknown } => typeof body === "object" && body !== null && !Array.isArray(body);
function specRequirements(body: unknown): RollupSpec | null {
  if (!object(body) || !Array.isArray(body.requirements) || !body.requirements.every(item => object(item) && typeof item.id === "string")) return null;
  return body as unknown as RollupSpec;
}
function integrationScope(body: unknown): IntegrationRequirementScope | null {
  if (!object(body) || !object(body.repository) || typeof body.repository.key !== "string" || !Array.isArray(body.briefs)) return null;
  if (!body.briefs.every(brief => object(brief) && Array.isArray(brief.build_items) && brief.build_items.every(item => object(item)
    && Array.isArray(item.requirement_ids) && item.requirement_ids.every(id => typeof id === "string")))) return null;
  return body as unknown as IntegrationRequirementScope;
}
export interface RequirementRollupRead {
  readonly units: readonly Pick<RunRead["units"][number], "id" | "stage" | "input">[];
  readonly revisions: readonly Pick<RunRead["revisions"][number], "id" | "unit_id" | "artifact" | "seq" | "body">[];
  readonly decisions: readonly Pick<RunRead["decisions"][number], "target_revision_id" | "review" | "effect">[];
}
/** A read-only transform over the authority snapshot; never writes or authors a rollup artifact. */
export function selectRequirementRollup(read: RequirementRollupRead): readonly RequirementRollup[] {
  const isApproved = (revision_id: string) => read.decisions.filter(decision => decision.target_revision_id === revision_id).at(-1)?.effect === "approve";
  const specRevision = read.revisions.filter(revision => revision.artifact === "spec" && isApproved(revision.id)).sort((a, b) => b.seq - a.seq)[0];
  const spec = specRevision ? specRequirements(specRevision.body) : null;
  if (!spec) return [];
  const integrations = read.units.filter(unit => unit.stage === "integration").flatMap(unit => {
    const scope = integrationScope(unit.input);
    if (!scope) return [];
    const revision = read.revisions.filter(revision => revision.unit_id === unit.id && revision.artifact === "assessment"
      && read.decisions.filter(decision => decision.target_revision_id === revision.id && decision.review === "integration_review").at(-1)?.effect === "approve")
      .sort((a, b) => b.seq - a.seq)[0];
    const body = revision?.body;
    const assessment = object(body) && typeof body.head_sha === "string" && Array.isArray(body.item_assessments)
      ? { head_sha: body.head_sha, item_assessments: body.item_assessments as readonly unknown[] } : null;
    return [{ scope, revision, assessment }];
  });
  return spec.requirements.map(requirement => {
    const repositories = integrations.filter(({ scope }) => scope.briefs.some(brief => brief.build_items.some(item => item.requirement_ids.includes(requirement.id))))
      .map(({ scope, revision, assessment }): RepositoryRequirementJudgment => {
        const item = assessment?.item_assessments.find(item => object(item) && object(item.subject) &&
          item.subject.kind === "requirement" && item.subject.id === requirement.id);
        const status = object(item) ? item.status : null;
        return (status === "met" || status === "partial" || status === "not_met") && revision && assessment ? { repository_key: scope.repository.key, status, revision_id: revision.id, head_sha: assessment.head_sha }
          : { repository_key: scope.repository.key, status: "pending", revision_id: null, head_sha: null };
      }).sort((a, b) => a.repository_key.localeCompare(b.repository_key));
    return { requirement_id: requirement.id, status: repositories.length > 0 && repositories.every(repository => repository.status !== "pending") ? "judged" : "pending", repositories };
  });
}

import type { Result } from "../../lib/result";
import type { CohortId, RepositoryKey } from "../types";

/** Mirrors `PlanCohort` in oakridge-dbos/src/domain/dev-flow-artifacts.ts. */
export interface PlanCohort {
  id: CohortId;
  repository_key: RepositoryKey | null;
  title: string;
  scope: string;
  depends_on: CohortId[];
  description: string | null;
  files_in_scope: string[];
  decisions: string[];
  acceptance_criteria: string[];
}

/** Mirrors `PlanScope` in oakridge-dbos/src/domain/dev-flow-artifacts.ts. */
export interface PlanScope {
  in_scope: string[];
  out_of_scope: string[];
}

/**
 * Mirrors `DevRisk`, except that `mitigation` is nullable: plan writers have
 * published risks as bare strings, and the dbos emit path does not reject them.
 */
export interface PlanRisk {
  description: string;
  mitigation: string | null;
}

/** Mirrors the registered oakridge-dbos `dev.plan` artifact body. */
export interface Plan {
  summary: string;
  cohorts: PlanCohort[];
  dependency_order: CohortId[];
  scope: PlanScope;
  acceptance_criteria: string[];
  risks: PlanRisk[];
}

export interface PlanParseError {
  operation: "parse_plan";
  field: string;
  detail: string;
}

type Parsed<T> = Result<T, PlanParseError>;

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { operation: "parse_plan", field, detail } });

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseString(value: unknown, field: string): Parsed<string> {
  return typeof value === "string" ? ok(value) : fail(field, "expected a string");
}

function parseNullableString(value: unknown, field: string): Parsed<string | null> {
  return value === undefined || value === null ? ok(null) : parseString(value, field);
}

function parseStringArray(value: unknown, field: string): Parsed<string[]> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? ok(value)
    : fail(field, "expected an array of strings");
}

function parseEach<T>(value: unknown, field: string, parseEntry: (entry: unknown, entryField: string) => Parsed<T>): Parsed<T[]> {
  if (!Array.isArray(value)) return fail(field, "expected an array");
  const parsed: T[] = [];
  for (const [index, entry] of value.entries()) {
    const result = parseEntry(entry, `${field}[${index}]`);
    if (!result.ok) return result;
    parsed.push(result.value);
  }
  return ok(parsed);
}

function parseCohort(value: unknown, field: string): Parsed<PlanCohort> {
  if (!isRecord(value)) return fail(field, "expected an object");
  const id = parseString(value.id, `${field}.id`);
  if (!id.ok) return id;
  const repositoryKey = parseNullableString(value.repository_key, `${field}.repository_key`);
  if (!repositoryKey.ok) return repositoryKey;
  const title = parseString(value.title, `${field}.title`);
  if (!title.ok) return title;
  const scope = parseString(value.scope, `${field}.scope`);
  if (!scope.ok) return scope;
  const dependsOn = parseStringArray(value.depends_on, `${field}.depends_on`);
  if (!dependsOn.ok) return dependsOn;
  const description = parseNullableString(value.description, `${field}.description`);
  if (!description.ok) return description;
  const files = parseStringArray(value.files_in_scope, `${field}.files_in_scope`);
  if (!files.ok) return files;
  const decisions = parseStringArray(value.decisions, `${field}.decisions`);
  if (!decisions.ok) return decisions;
  const criteria = parseStringArray(value.acceptance_criteria, `${field}.acceptance_criteria`);
  if (!criteria.ok) return criteria;
  return ok({
    id: id.value as CohortId,
    repository_key: repositoryKey.value as RepositoryKey | null,
    title: title.value,
    scope: scope.value,
    depends_on: dependsOn.value as CohortId[],
    description: description.value,
    files_in_scope: files.value,
    decisions: decisions.value,
    acceptance_criteria: criteria.value,
  });
}

function parseRisk(value: unknown, field: string): Parsed<PlanRisk> {
  if (typeof value === "string") return ok({ description: value, mitigation: null });
  if (!isRecord(value)) return fail(field, "expected a string or an object");
  const description = parseString(value.description, `${field}.description`);
  if (!description.ok) return description;
  const mitigation = parseNullableString(value.mitigation, `${field}.mitigation`);
  if (!mitigation.ok) return mitigation;
  return ok({ description: description.value, mitigation: mitigation.value });
}

function parseScope(value: unknown, field: string): Parsed<PlanScope> {
  if (!isRecord(value)) return fail(field, "expected an object");
  const inScope = parseStringArray(value.in_scope, `${field}.in_scope`);
  if (!inScope.ok) return inScope;
  const outOfScope = parseStringArray(value.out_of_scope, `${field}.out_of_scope`);
  if (!outOfScope.ok) return outOfScope;
  return ok({ in_scope: inScope.value, out_of_scope: outOfScope.value });
}

export function parsePlan(body: unknown): Parsed<Plan> {
  if (!isRecord(body)) return fail("body", "expected an object");
  const summary = parseString(body.summary, "summary");
  if (!summary.ok) return summary;
  const cohorts = parseEach(body.cohorts, "cohorts", parseCohort);
  if (!cohorts.ok) return cohorts;
  const order = parseStringArray(body.dependency_order, "dependency_order");
  if (!order.ok) return order;
  const scope = parseScope(body.scope, "scope");
  if (!scope.ok) return scope;
  const criteria = parseStringArray(body.acceptance_criteria, "acceptance_criteria");
  if (!criteria.ok) return criteria;
  const risks = parseEach(body.risks, "risks", parseRisk);
  if (!risks.ok) return risks;
  return ok({
    summary: summary.value,
    cohorts: cohorts.value,
    dependency_order: order.value as CohortId[],
    scope: scope.value,
    acceptance_criteria: criteria.value,
    risks: risks.value,
  });
}

/** Cohorts in `dependency_order`; any cohort the order omits follows in body order. */
export function selectOrderedCohorts(plan: Plan): PlanCohort[] {
  const byId = new Map(plan.cohorts.map((cohort) => [cohort.id, cohort]));
  const ordered = [...new Set(plan.dependency_order)].flatMap((id) => byId.get(id) ?? []);
  const placed = new Set(ordered.map((cohort) => cohort.id));
  return [...ordered, ...plan.cohorts.filter((cohort) => !placed.has(cohort.id))];
}

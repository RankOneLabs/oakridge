import { useState } from "react";
import { DagEditor } from "../../review/plan/DagEditor";
import type { Cohort, CohortDependency } from "../../review/plan/types";
import type { ArtifactReviewDescriptor } from "../types";

// dev.plan body shape (subset used for display)
interface PlanBody {
  summary?: string;
  cohorts?: unknown[];
  dependency_order?: unknown[];
  dependencies?: unknown[];
  dependency_edges?: unknown[];
  scope?: unknown;
  acceptance_criteria?: unknown[];
  risks?: unknown[];
}

// Adapt plan.body.cohorts → DagEditor's Cohort[]
function adaptCohorts(raw: unknown[]): Cohort[] {
  return raw.map((c, i) => {
    const obj = c as Record<string, unknown>;
    return {
      id: String(obj.id ?? i),
      plan_id: "",
      title: String(obj.title ?? obj.id ?? `Cohort ${i + 1}`),
      notes: typeof obj.notes === "string" ? obj.notes : null,
      position: typeof obj.position === "number" ? obj.position : i,
      status: "planned" as const,
      created_at: "",
    };
  });
}

interface Props {
  body: unknown;
  descriptor?: ArtifactReviewDescriptor | null;
}

export function adaptDependencies(raw: unknown[]): CohortDependency[] {
  return raw.flatMap((entry, index) => {
    const value = entry as Record<string, unknown>;
    const from = value.from_cohort_id ?? value.from ?? value.depends_on;
    const to = value.to_cohort_id ?? value.to ?? value.cohort_id;
    return from != null && to != null ? [{
      id: String(value.id ?? `dependency-${index}`),
      from_cohort_id: String(from),
      to_cohort_id: String(to),
    }] : [];
  });
}

export function deriveCohortDependencies(rawCohorts: unknown[]): CohortDependency[] {
  return rawCohorts.flatMap((entry, cohortIndex) => {
    const cohort = entry as Record<string, unknown>;
    const cohortId = String(cohort.id ?? cohortIndex);
    const dependsOn = Array.isArray(cohort.depends_on) ? cohort.depends_on : [];
    return dependsOn.map((dependencyId, dependencyIndex) => ({
      id: `dependency-${String(dependencyId)}-${cohortId}-${dependencyIndex}`,
      from_cohort_id: String(dependencyId),
      to_cohort_id: cohortId,
    }));
  });
}

export function PlanViewer({ body, descriptor }: Props) {
  const data = body as PlanBody;
  const [selectedCohortId, setSelectedCohortId] = useState<string | null>(null);

  const rawCohorts = Array.isArray(data.cohorts) ? data.cohorts : [];
  const rawOrder = Array.isArray(data.dependency_order) ? data.dependency_order : [];
  const rawDependencies = Array.isArray(data.dependency_edges)
    ? data.dependency_edges
    : Array.isArray(data.dependencies) ? data.dependencies : [];
  const dependencies = rawDependencies.length > 0
    ? adaptDependencies(rawDependencies)
    : deriveCohortDependencies(rawCohorts);
  const configuredSections = descriptor?.sections ?? [];
  const visible = (section: string) => configuredSections.length === 0 || configuredSections.includes(section);
  const cohorts = adaptCohorts(rawCohorts);
  // dependency_order is a topological sort of IDs, not an explicit edge list;
  // passing empty deps avoids rendering a false linear chain. Explicit edges
  // will be wired when the artifact body carries them (cohort 5+).

  return (
    <div className="or-viewer or-viewer--plan">
      {data.summary && visible("summary") && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Summary</h3>
          <p className="or-viewer__summary">{data.summary}</p>
        </section>
      )}

      {cohorts.length > 0 && visible("cohorts") && (
        <section className="or-viewer__section or-viewer__section--dag">
          <h3 className="or-viewer__section-title">Cohorts ({cohorts.length})</h3>
          <div style={{ height: 400 }}>
            <DagEditor
              cohorts={cohorts}
              deps={dependencies}
              threads={[]}
              mode="review"
              frozen={true}
              selectedCohortId={selectedCohortId}
              onSelectCohort={setSelectedCohortId}
              onOpenThread={() => undefined}
              onAddEdge={() => Promise.resolve()}
              onDeleteEdge={() => Promise.resolve()}
              onUpdatePosition={() => Promise.resolve()}
            />
          </div>
        </section>
      )}

      {rawOrder.length > 0 && visible("dependency_order") && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Dependency Order</h3>
          <ol className="or-viewer__list">
            {rawOrder.map((id, i) => (
              <li key={i} className="or-viewer__list-item">
                <code>{String(id)}</code>
              </li>
            ))}
          </ol>
        </section>
      )}

      {data.scope !== undefined && visible("scope") && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Scope</h3>
          <pre className="or-pre">{typeof data.scope === "string" ? data.scope : JSON.stringify(data.scope, null, 2)}</pre>
        </section>
      )}

      {Array.isArray(data.acceptance_criteria) && data.acceptance_criteria.length > 0 && visible("acceptance_criteria") && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Acceptance Criteria</h3>
          <ul className="or-viewer__list">
            {data.acceptance_criteria.map((c, i) => (
              <li key={i} className="or-viewer__list-item">
                {typeof c === "string" ? c : JSON.stringify(c)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {Array.isArray(data.risks) && data.risks.length > 0 && visible("risks") && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Risks</h3>
          <ul className="or-viewer__list">
            {data.risks.map((risk, index) => (
              <li key={index} className="or-viewer__list-item">
                {typeof risk === "string" ? risk : JSON.stringify(risk)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

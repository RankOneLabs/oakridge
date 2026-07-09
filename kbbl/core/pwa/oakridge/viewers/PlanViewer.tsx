import { useState } from "react";
import { DagEditor } from "../../review/plan/DagEditor";
import type { Cohort, CohortDependency } from "../../review/plan/types";

// dev.plan body shape (subset used for display)
interface PlanBody {
  summary?: string;
  cohorts?: unknown[];
  dependency_order?: unknown[];
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

// Adapt plan.body.dependency_order → DagEditor's CohortDependency[]
// dependency_order is an array of cohort IDs in topological order;
// we derive edges from consecutive pairs.
function adaptDeps(cohorts: Cohort[], order: unknown[]): CohortDependency[] {
  const ids = order.map(String);
  const cohortIds = new Set(cohorts.map((c) => c.id));
  const deps: CohortDependency[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const from = ids[i];
    const to = ids[i + 1];
    if (cohortIds.has(from) && cohortIds.has(to)) {
      deps.push({ id: `${from}->${to}`, from_cohort_id: from, to_cohort_id: to });
    }
  }
  return deps;
}

interface Props {
  body: unknown;
}

export function PlanViewer({ body }: Props) {
  const data = body as PlanBody;
  const [selectedCohortId, setSelectedCohortId] = useState<string | null>(null);

  const rawCohorts = Array.isArray(data.cohorts) ? data.cohorts : [];
  const rawOrder = Array.isArray(data.dependency_order) ? data.dependency_order : [];

  const cohorts = adaptCohorts(rawCohorts);
  const deps = adaptDeps(cohorts, rawOrder);

  return (
    <div className="or-viewer or-viewer--plan">
      {data.summary && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Summary</h3>
          <p className="or-viewer__summary">{data.summary}</p>
        </section>
      )}

      {cohorts.length > 0 && (
        <section className="or-viewer__section or-viewer__section--dag">
          <h3 className="or-viewer__section-title">Cohorts ({cohorts.length})</h3>
          <div style={{ height: 400 }}>
            <DagEditor
              cohorts={cohorts}
              deps={deps}
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

      {Array.isArray(data.acceptance_criteria) && data.acceptance_criteria.length > 0 && (
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
    </div>
  );
}

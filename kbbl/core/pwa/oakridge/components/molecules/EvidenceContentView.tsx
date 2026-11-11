import type { EvidenceContent } from "../../lib/evidence-content";
import { ExpandableText } from "./ExpandableText";
import { StructuredValue } from "./StructuredValue";
import { TestEvidenceBlock } from "./TestEvidenceBlock";

function Field({ label, value }: { label: string; value: unknown }) {
  return <div className="min-w-0"><dt className="text-xs font-medium text-[var(--text-muted)]">{label}</dt><dd className="m-0 text-xs text-[var(--text-secondary)]">
    {typeof value === "string" ? <ExpandableText text={value} className="whitespace-pre-wrap break-words" /> : <StructuredValue value={value} />}
  </dd></div>;
}

/** Compact read-only fields from the same validated models as the artifact viewers. */
export function EvidenceContentView({ content }: { content: EvidenceContent }) {
  const { value } = content;
  switch (content.kind) {
    case "unknown": return <StructuredValue value={value} />;
    case "file_text": return <div><div className="text-xs font-medium text-[var(--text-muted)]">File text</div><ExpandableText text={content.value} className="whitespace-pre-wrap break-words font-mono text-xs text-[var(--text-secondary)]" /></div>;
    case "spec_text": return <dl><Field label="Spec" value={content.value} /></dl>;
    case "test_evidence": return <TestEvidenceBlock tests={content.value} testId="or-evidence-test-results" />;
    case "finding": return <dl className="m-0 space-y-1">
      <Field label="Id" value={content.value.id} />
      <Field label="Description" value={content.value.description} />
      <Field label="Severity" value={content.value.severity} />
    </dl>;
    case "assessment_finding": return <dl className="m-0 space-y-1">
      <Field label="Description" value={content.value.description} />
      <Field label="Status" value={content.value.status} />
      <Field label="Task ids" value={content.value.task_ids} />
      <Field label="Evidence" value={content.value.evidence} />
    </dl>;
    case "task": return <dl className="m-0 space-y-1">
      <Field label="Id" value={content.value.id} />
      <Field label="Description" value={content.value.description} />
      <Field label="Requirement ids" value={content.value.requirement_ids} />
    </dl>;
    case "acceptance_entry": return <dl className="m-0 space-y-1">
      <Field label="Id" value={content.value.id} />
      <Field label="Text" value={content.value.text} />
      <Field label="Decision ids" value={content.value.decision_ids} />
    </dl>;
    case "requirement": return <dl className="m-0 space-y-1">
      <Field label="Id" value={content.value.id} />
      <Field label="Description" value={content.value.description} />
      <Field label="Status" value={content.value.status} />
    </dl>;
    case "reported_citation": return <dl className="m-0 space-y-1">
      <Field label="Kind" value={content.value.kind} />
      <Field label="Citation" value={content.value.citation} />
      <Field label="Detail" value={content.value.detail} />
    </dl>;
    case "plan": return <dl className="m-0 space-y-1">
      <Field label="Summary" value={content.value.summary} />
      <Field label="Cohorts" value={content.value.cohorts} />
      <Field label="Dependency order" value={content.value.dependency_order} />
      <Field label="Scope" value={content.value.scope} />
      <Field label="Acceptance criteria" value={content.value.acceptance_criteria} />
      <Field label="Risks" value={content.value.risks} />
    </dl>;
    case "plan_cohort": return <dl className="m-0 space-y-1">
      <Field label="Id" value={content.value.id} />
      <Field label="Repository key" value={content.value.repository_key} />
      <Field label="Title" value={content.value.title} />
      <Field label="Scope" value={content.value.scope} />
      <Field label="Description" value={content.value.description} />
      <Field label="Depends on" value={content.value.depends_on} />
      <Field label="Files in scope" value={content.value.files_in_scope} />
      <Field label="Decisions" value={content.value.decisions} />
      <Field label="Acceptance criteria" value={content.value.acceptance_criteria} />
    </dl>;
    case "brief": return <dl className="m-0 space-y-1">
      <Field label="Title" value={content.value.title} />
      <Field label="Cohort id" value={content.value.cohort_id} />
      <Field label="Repository key" value={content.value.repository_key} />
      <Field label="Goal" value={content.value.goal} />
      <Field label="Depends on" value={content.value.depends_on} />
      <Field label="Files in scope" value={content.value.files_in_scope} />
      <Field label="Decisions made" value={content.value.decisions_made} />
      <Field label="Approaches rejected" value={content.value.approaches_rejected} />
      <Field label="Acceptance criteria" value={content.value.acceptance_criteria} />
      <Field label="Next action" value={content.value.next_action} />
    </dl>;
    case "build_result": return <dl className="m-0 space-y-1">
      <Field label="Summary" value={content.value.summary} />
      <Field label="Head sha" value={content.value.head_sha} />
      <Field label="Repository key" value={content.value.repository_key} />
      <Field label="Changed files" value={content.value.changed_files} />
      <div><dt className="text-xs font-medium text-[var(--text-muted)]">Tests</dt><dd className="m-0"><TestEvidenceBlock tests={content.value.tests} testId="or-evidence-test-results" /></dd></div>
      <Field label="Delegated session metadata" value={content.value.delegated_session_metadata} />
      <Field label="Known issues" value={content.value.known_issues} />
    </dl>;
    default: {
      const exhaustive: never = content;
      return exhaustive;
    }
  }
}

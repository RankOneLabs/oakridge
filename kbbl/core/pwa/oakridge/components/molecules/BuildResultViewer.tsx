import { Chip } from "../../../components/atoms/Chip";
import { selectFileScopeComparison, selectHasBlockingIssue, selectOrderedIssues, selectTestEvidenceText, type BuildIssue, type BuildResult, type CohortBriefLookup, type TestEvidence } from "../../lib/build-result";
import { selectStatusTone } from "../../lib/status-tone";
import { ArtifactSection, artifactLabelClass } from "./ArtifactSection";
import { BuildFileScope } from "./BuildFileScope";
import { ExpandableText } from "./ExpandableText";

interface Props {
  result: BuildResult;
  brief: CohortBriefLookup;
  cohortLabel: string | null;
}

function BriefNote({ brief }: { brief: Exclude<CohortBriefLookup, { kind: "found" }> }) {
  const text = brief.kind === "loading"
    ? "Loading the cohort's brief…"
    : `No build brief for ${brief.cohort_label ? `cohort ${brief.cohort_label}` : "this cohort"} in this run, so there is nothing to compare against.`;
  return <p className="text-xs text-[var(--text-muted)]" data-testid="or-build-brief-note">{text}</p>;
}

function IssueList({ issues }: { issues: BuildIssue[] }) {
  if (issues.length === 0) {
    return <p className="text-sm text-[var(--success-fg)]" data-testid="or-build-no-issues">No known issues.</p>;
  }
  const hasBlocking = selectHasBlockingIssue(issues);
  return (
    <ul
      className={`m-0 list-none divide-y rounded-md border px-3 py-0 ${hasBlocking ? "divide-[var(--danger-card-border)] border-[var(--danger-card-border)] bg-[var(--danger-card-bg)]" : "divide-[var(--amber-border)] border-[var(--amber-border)] bg-[var(--amber-bg)]"}`}
      data-testid="or-build-issues"
      role={hasBlocking ? "alert" : undefined}
    >
      {issues.map((issue, index) => (
        <li key={`${index}-${issue.description}`} className="flex items-start gap-2 py-2">
          <Chip tone={selectStatusTone(issue.severity)} className="shrink-0">{issue.severity}</Chip>
          <ExpandableText text={issue.description} className="text-sm text-[var(--text-primary)]" />
        </li>
      ))}
    </ul>
  );
}

function TestEvidenceBlock({ tests }: { tests: TestEvidence }) {
  const evidence = selectTestEvidenceText(tests);
  return (
    <div className="flex flex-col gap-2" data-testid="or-build-tests">
      <div className="flex flex-wrap gap-1.5">
        <Chip tone={tests.passed > 0 ? "success" : "muted"}>{tests.passed} passed</Chip>
        <Chip tone={tests.failed > 0 ? "danger" : "muted"}>{tests.failed} failed</Chip>
      </div>
      {evidence.map((text, index) => (
        <div key={index} className="rounded-md bg-[var(--bg-code)] px-3 py-2">
          <ExpandableText text={text} className="whitespace-pre-wrap font-mono text-xs text-[var(--text-secondary)]" />
        </div>
      ))}
    </div>
  );
}

export function BuildResultViewer({ result, brief, cohortLabel }: Props) {
  const branch = result.delegated_session_metadata?.branch ?? null;
  const issues = selectOrderedIssues(result.known_issues);

  return (
    <article className="flex flex-col gap-5" data-testid="or-build-result-viewer">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={artifactLabelClass}>Build result</span>
          {cohortLabel && <code className="or-code">{cohortLabel}</code>}
          {result.repository_key && <Chip tone="neutral">{result.repository_key}</Chip>}
          {branch && <Chip tone="muted" className="font-mono">{branch}</Chip>}
        </div>
        {brief.kind === "found" && <h2 className="m-0 text-lg font-semibold leading-snug text-[var(--text-primary)]">{brief.brief.title}</h2>}
      </header>

      <ArtifactSection title="What was built" testId="or-build-summary">
        <ExpandableText text={result.summary} lineCount={6} className="text-sm leading-relaxed text-[var(--text-primary)]" />
      </ArtifactSection>

      {brief.kind === "found" && (
        <ArtifactSection title="What the brief asked for" testId="or-build-brief-goal">
          <div className="rounded-md border-l-4 border-[var(--border-muted)] px-3 py-1">
            <ExpandableText text={brief.brief.goal} className="text-sm text-[var(--text-secondary)]" />
          </div>
        </ArtifactSection>
      )}

      <ArtifactSection title={`Known issues (${issues.length})`} testId="or-build-issues-section">
        <IssueList issues={issues} />
      </ArtifactSection>

      <ArtifactSection title="Tests" testId="or-build-tests-section">
        <TestEvidenceBlock tests={result.tests} />
      </ArtifactSection>

      <ArtifactSection title={`Changed files (${result.changed_files.length})`} testId="or-build-files">
        {brief.kind === "found" ? (
          <BuildFileScope comparison={selectFileScopeComparison(brief.brief.files_in_scope, result.changed_files)} />
        ) : (
          <>
            <BriefNote brief={brief} />
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {result.changed_files.map((file) => <li key={file} className="font-mono text-xs text-[var(--text-secondary)]">{file}</li>)}
            </ul>
          </>
        )}
      </ArtifactSection>

      {brief.kind === "found" && (
        <ArtifactSection title={`The brief's acceptance criteria (${brief.brief.acceptance_criteria.length})`} testId="or-build-acceptance">
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm text-[var(--text-secondary)]">
            {brief.brief.acceptance_criteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}
          </ol>
        </ArtifactSection>
      )}
    </article>
  );
}

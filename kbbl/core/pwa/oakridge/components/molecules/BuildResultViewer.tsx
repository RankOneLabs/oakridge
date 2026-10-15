import { Chip } from "../../../components/atoms/Chip";
import { selectFileScopeComparison, selectHasBlockingIssue, selectOrderedIssues, type BuildIssue, type BuildResult } from "../../lib/build-result";
import type { BuildBrief } from "../../lib/build-brief";
import type { CohortArtifactLookup } from "../../lib/cohort-artifact";
import { selectStatusTone } from "../../lib/status-tone";
import { ArtifactSection, artifactLabelClass } from "./ArtifactSection";
import { BuildFileScope } from "./BuildFileScope";
import { CohortArtifactNote } from "./CohortArtifactNote";
import { ExpandableText } from "./ExpandableText";
import { TestEvidenceBlock } from "./TestEvidenceBlock";

interface Props {
  result: BuildResult;
  brief: CohortArtifactLookup<BuildBrief>;
  cohortLabel: string | null;
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
        {brief.kind === "found" && <h2 className="m-0 text-lg font-semibold leading-snug text-[var(--text-primary)]">{brief.value.title}</h2>}
      </header>

      <ArtifactSection title="What was built" testId="or-build-summary">
        <ExpandableText text={result.summary} lineCount={6} className="text-sm leading-relaxed text-[var(--text-primary)]" />
      </ArtifactSection>

      {brief.kind === "found" && (
        <ArtifactSection title="What the brief asked for" testId="or-build-brief-goal">
          <div className="rounded-md border-l-4 border-[var(--border-muted)] px-3 py-1">
            <ExpandableText text={brief.value.goal} className="text-sm text-[var(--text-secondary)]" />
          </div>
        </ArtifactSection>
      )}

      <ArtifactSection title={`Known issues (${issues.length})`} testId="or-build-issues-section">
        <IssueList issues={issues} />
      </ArtifactSection>

      <ArtifactSection title="Tests" testId="or-build-tests-section">
        <TestEvidenceBlock tests={result.tests} testId="or-build-tests" />
      </ArtifactSection>

      <ArtifactSection title={`Changed files (${result.changed_files.length})`} testId="or-build-files">
        {brief.kind === "found" ? (
          <BuildFileScope comparison={selectFileScopeComparison(brief.value.files_in_scope, result.changed_files)} />
        ) : (
          <>
            <CohortArtifactNote lookup={brief} artifactName="build brief" testId="or-build-brief-note" />
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {result.changed_files.map((file) => <li key={file} className="font-mono text-xs text-[var(--text-secondary)]">{file}</li>)}
            </ul>
          </>
        )}
      </ArtifactSection>

      {brief.kind === "found" && (
        <ArtifactSection title={`The brief's acceptance criteria (${brief.value.acceptance_criteria.length})`} testId="or-build-acceptance">
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm text-[var(--text-secondary)]">
            {brief.value.acceptance_criteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}
          </ol>
        </ArtifactSection>
      )}
    </article>
  );
}

import { Chip } from "../../../components/atoms/Chip";
import type { ViewerProps } from "../../artifactRegistry";
import { isWebUrl, parsePrSummary, selectPullRequestLabel } from "../../lib/pr-summary";
import { selectStatusTone } from "../../lib/status-tone";
import { ArtifactSection, artifactLabelClass } from "./ArtifactSection";

export function PrSummaryViewer({ body, source }: ViewerProps) {
  const parsed = parsePrSummary(body);
  if (!parsed.ok) {
    return <div className="or-error" role="alert">This PR summary does not match the registered contract ({parsed.error.field}: {parsed.error.detail}).</div>;
  }
  const pr = parsed.value;
  const label = selectPullRequestLabel(pr.pr_url);

  return (
    <article className="flex flex-col gap-5" data-testid="or-pr-summary-viewer">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={artifactLabelClass}>Pull request</span>
          {source?.label && <code className="or-code">{source.label}</code>}
          {pr.repository_key && <Chip tone="neutral">{pr.repository_key}</Chip>}
          {pr.review_status && <Chip tone={selectStatusTone(pr.review_status)}>{pr.review_status.replaceAll("_", " ")}</Chip>}
        </div>
        {isWebUrl(pr.pr_url) ? (
          <a
            href={pr.pr_url}
            target="_blank"
            rel="noopener noreferrer"
            className="self-start text-lg font-semibold text-[var(--accent-blue)] no-underline hover:underline"
            data-testid="or-pr-url"
          >
            {label ?? pr.pr_url} ↗
          </a>
        ) : <span className="or-code self-start" data-testid="or-pr-url">{pr.pr_url}</span>}
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-[var(--text-secondary)]" data-testid="or-pr-branches">
          <span>{pr.branch}</span>
          {pr.base_branch && (
            <>
              <span className="text-[var(--text-muted)]">→</span>
              <span>{pr.base_branch}</span>
            </>
          )}
        </div>
      </header>

      <ArtifactSection title="Summary" testId="or-pr-summary">
        <p className="text-sm leading-relaxed text-[var(--text-primary)]">{pr.summary}</p>
      </ArtifactSection>
    </article>
  );
}

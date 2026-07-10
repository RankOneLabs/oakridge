interface PrSummaryBody {
  pr_url?: string;
  branch?: string;
  summary?: string;
  review_status?: string;
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

interface Props {
  body: unknown;
}

export function PrSummaryViewer({ body }: Props) {
  const data = body as PrSummaryBody;

  return (
    <div className="or-viewer or-viewer--pr-summary">
      {data.pr_url && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Pull Request</h3>
          <div className="or-viewer__pr-row">
            {isSafeUrl(data.pr_url) ? (
              <a
                href={data.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="or-link"
                data-testid="or-pr-url"
              >
                {data.pr_url}
              </a>
            ) : (
              <span className="or-code" data-testid="or-pr-url">{data.pr_url}</span>
            )}
            {data.review_status && (
              <span className={`or-chip or-chip--${data.review_status}`}>
                {data.review_status}
              </span>
            )}
          </div>
        </section>
      )}

      {data.branch && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Branch</h3>
          <code className="or-code">{data.branch}</code>
        </section>
      )}

      {data.summary && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Summary</h3>
          <p className="or-viewer__summary">{data.summary}</p>
        </section>
      )}
    </div>
  );
}

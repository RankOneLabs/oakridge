interface PrSummaryBody {
  pr_url?: string;
  branch?: string;
  summary?: string;
  review_status?: string;
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
            <a
              href={data.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="or-link"
              data-testid="or-pr-url"
            >
              {data.pr_url}
            </a>
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

interface Finding {
  description?: string;
  severity?: string;
  [key: string]: unknown;
}

interface AssessmentBody {
  verdict?: string;
  findings?: Finding[];
  test_evidence?: unknown;
  recommended_next_actions?: unknown[];
}

interface Props {
  body: unknown;
}

export function AssessmentViewer({ body }: Props) {
  const data = body as AssessmentBody;

  return (
    <div className="or-viewer or-viewer--assessment">
      {data.verdict && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Verdict</h3>
          <span className={`or-chip or-chip--${data.verdict}`} data-testid="or-assessment-verdict">
            {data.verdict}
          </span>
        </section>
      )}

      {Array.isArray(data.findings) && data.findings.length > 0 && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Findings ({data.findings.length})</h3>
          <ul className="or-viewer__list">
            {data.findings.map((f, i) => (
              <li key={i} className="or-viewer__list-item">
                {f.severity && <span className={`or-chip or-chip--${f.severity}`}>{f.severity}</span>}
                <span>{f.description ?? JSON.stringify(f)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.test_evidence !== undefined && data.test_evidence !== null && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Test Evidence</h3>
          <pre className="or-pre">{JSON.stringify(data.test_evidence, null, 2)}</pre>
        </section>
      )}

      {Array.isArray(data.recommended_next_actions) && data.recommended_next_actions.length > 0 && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Recommended Next Actions</h3>
          <ul className="or-viewer__list">
            {data.recommended_next_actions.map((a, i) => (
              <li key={i} className="or-viewer__list-item">
                {typeof a === "string" ? a : JSON.stringify(a)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

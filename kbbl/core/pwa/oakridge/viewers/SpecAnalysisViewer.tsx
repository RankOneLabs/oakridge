interface Finding {
  id?: string;
  description?: string;
  severity?: string;
  [key: string]: unknown;
}

interface Requirement {
  id?: string;
  description?: string;
  status?: string;
  [key: string]: unknown;
}

interface Risk {
  description?: string;
  severity?: string;
  [key: string]: unknown;
}

interface SpecAnalysisBody {
  summary?: string;
  source_spec_refs?: unknown[];
  findings?: Finding[];
  requirements?: Requirement[];
  risks?: Risk[];
}

interface Props {
  body: unknown;
}

export function SpecAnalysisViewer({ body }: Props) {
  const data = body as SpecAnalysisBody;

  return (
    <div className="or-viewer or-viewer--spec-analysis">
      {data.summary && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Summary</h3>
          <p className="or-viewer__summary">{data.summary}</p>
        </section>
      )}

      {Array.isArray(data.findings) && data.findings.length > 0 && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Findings ({data.findings.length})</h3>
          <ul className="or-viewer__list">
            {data.findings.map((f, i) => (
              <li key={f.id ?? i} className="or-viewer__list-item">
                {f.severity && (
                  <span className={`or-chip or-chip--${f.severity}`}>{f.severity}</span>
                )}
                <span>{f.description ?? JSON.stringify(f)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {Array.isArray(data.requirements) && data.requirements.length > 0 && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Requirements ({data.requirements.length})</h3>
          <ul className="or-viewer__list">
            {data.requirements.map((r, i) => (
              <li key={r.id ?? i} className="or-viewer__list-item">
                {r.status && <span className="or-chip">{r.status}</span>}
                <span>{r.description ?? JSON.stringify(r)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {Array.isArray(data.risks) && data.risks.length > 0 && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Risks ({data.risks.length})</h3>
          <ul className="or-viewer__list">
            {data.risks.map((r, i) => (
              <li key={i} className="or-viewer__list-item">
                {r.severity && <span className={`or-chip or-chip--${r.severity}`}>{r.severity}</span>}
                <span>{r.description ?? JSON.stringify(r)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

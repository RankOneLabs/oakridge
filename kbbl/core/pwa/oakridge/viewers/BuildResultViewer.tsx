interface Tests {
  passed?: number;
  failed?: number;
  [key: string]: unknown;
}

interface BuildResultBody {
  summary?: string;
  changed_files?: string[];
  tests?: Tests;
  known_issues?: unknown[];
  delegated_session_metadata?: unknown;
}

interface Props {
  body: unknown;
}

export function BuildResultViewer({ body }: Props) {
  const data = body as BuildResultBody;
  const tests = data.tests as Tests | undefined;
  const passed = tests?.passed;
  const failed = tests?.failed;

  return (
    <div className="or-viewer or-viewer--build-result">
      {data.summary && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Summary</h3>
          <p className="or-viewer__summary">{data.summary}</p>
        </section>
      )}

      {tests !== undefined && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Tests</h3>
          <div className="or-viewer__test-row">
            {passed !== undefined && (
              <span className="or-chip or-chip--pass">{passed} passed</span>
            )}
            {failed !== undefined && (
              <span className={`or-chip or-chip--${failed > 0 ? "fail" : "pass"}`}>
                {failed} failed
              </span>
            )}
            {passed === undefined && failed === undefined && (
              <pre className="or-pre">{JSON.stringify(tests, null, 2)}</pre>
            )}
          </div>
        </section>
      )}

      {Array.isArray(data.changed_files) && data.changed_files.length > 0 && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Changed Files ({data.changed_files.length})</h3>
          <ul className="or-viewer__list or-viewer__list--mono">
            {data.changed_files.map((f, i) => (
              <li key={i} className="or-viewer__list-item">
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {Array.isArray(data.known_issues) && data.known_issues.length > 0 && (
        <section className="or-viewer__section">
          <h3 className="or-viewer__section-title">Known Issues ({data.known_issues.length})</h3>
          <ul className="or-viewer__list">
            {data.known_issues.map((issue, i) => (
              <li key={i} className="or-viewer__list-item">
                {typeof issue === "string" ? issue : JSON.stringify(issue)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

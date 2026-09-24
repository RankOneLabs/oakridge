import type { ArtifactRevision, ArtifactReviewDescriptor } from "../../types";

/**
 * A whole body or validation payload, pretty-printed. A value that cannot be
 * stringified — a cycle, a BigInt — still has to render something, so the
 * failure becomes text rather than an exception thrown through the review
 * surface.
 */
function stringifyPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * One descriptor-named section's value. A section that holds prose is shown as
 * prose rather than as a quoted JSON string, which is the one way this differs
 * from printing the whole payload.
 */
function stringifySection(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface ArtifactJsonRevisionPanelProps {
  revision: ArtifactRevision;
  descriptor?: ArtifactReviewDescriptor | null;
}

/**
 * What a revision looks like when no registered viewer claims it: the
 * descriptor's named sections when the body is a keyed object, and the raw
 * pretty-printed body otherwise.
 *
 * Presentational — it renders the revision it is handed and owns nothing.
 */
export function ArtifactJsonRevisionPanel({ revision, descriptor }: ArtifactJsonRevisionPanelProps) {
  const bodyText = stringifyPayload(revision.body);
  const validationText =
    revision.validation !== null && revision.validation !== undefined
      ? stringifyPayload(revision.validation)
      : null;

  const sections = descriptor?.sections ?? [];
  const isKeyedBody =
    revision.body !== null && typeof revision.body === "object" && !Array.isArray(revision.body);

  return (
    <div className="or-revision-panel" data-testid="or-revision-panel">
      <div className="or-revision-panel__body">
        <span className="or-label">Body</span>
        {sections.length > 0 && isKeyedBody ? (
          <div data-testid="or-descriptor-sections">
            {sections.map((section) => {
              const value = (revision.body as Record<string, unknown>)[section];
              return value === undefined ? null : (
                <section key={section} data-artifact-section={section}>
                  <h3 className="or-viewer__section-title">{section.replaceAll("_", " ")}</h3>
                  <pre className="or-pre">{stringifySection(value)}</pre>
                </section>
              );
            })}
          </div>
        ) : (
          <pre className="or-pre" data-testid="or-revision-body">{bodyText}</pre>
        )}
      </div>
      {validationText && (
        <div className="or-revision-panel__validation">
          <span className="or-label">Validation</span>
          <pre className="or-pre" data-testid="or-revision-validation">{validationText}</pre>
        </div>
      )}
    </div>
  );
}

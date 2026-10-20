import type { ViewerProps } from "../../artifactRegistry";

/** The approved specification is a text artifact, exactly as the workflow publishes it. */
export function SpecViewer({ body }: ViewerProps) {
  if (typeof body !== "string") return <div className="or-error" role="alert">This specification is not text.</div>;
  return <article className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text-primary)]">{body}</article>;
}

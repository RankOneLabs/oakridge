import type { ViewerProps } from "../../artifactRegistry";
import { specDiff } from "../../lib/spec-diff";

/** The approved specification is a text artifact, exactly as the workflow publishes it. */
export function SpecViewer({ body, source }: ViewerProps) {
  if (typeof body !== "string") return <div className="or-error" role="alert">This specification is not text.</div>;
  const original = source?.original_spec;
  return <div className="space-y-4">
    {typeof original === "string" && <details className="rounded border border-[var(--border)] p-3">
      <summary className="cursor-pointer text-sm font-medium">Changes from original spec</summary>
      <div className="mt-3 overflow-x-auto rounded bg-[var(--surface)] font-mono text-xs" aria-label="Spec diff">
        {specDiff(original, body).map((line, index) => <div key={index}
          className={`whitespace-pre-wrap break-words px-2 ${line.kind === "added" ? "bg-green-500/15" : line.kind === "removed" ? "bg-red-500/15" : ""}`}>
          <span className="mr-2 select-none" aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>{line.text || " "}
        </div>)}
      </div>
    </details>}
    <article className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text-primary)]">{body}</article>
  </div>;
}

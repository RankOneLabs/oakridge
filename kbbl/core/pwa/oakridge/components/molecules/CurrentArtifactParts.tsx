import type { MouseEvent } from "react";
import type { CanonicalRequirement } from "../../lib/current-contract";
import type { ViewerProps } from "../../artifactRegistry";
import { Button } from "../../../components/atoms/Button";
export function CurrentParseFailure({ body, detail }: { body: unknown; detail: string }) {
  return <section><p role="alert">Could not read this artifact: {detail}</p><pre className="whitespace-pre-wrap break-words">{JSON.stringify(body, null, 2)}</pre></section>;
}
export function SourceReferences({ refs }: { refs: readonly string[] }) {
  return <ul>{refs.map((ref, index) => <li key={index}><a className="underline" href={/^https?:\/\//i.test(ref) ? ref : "#original-input"} onClick={/^https?:\/\//i.test(ref) ? undefined : (event) => navigateArtifactAnchor(event, "original-input")}>{ref}</a></li>)}</ul>;
}
export function OriginalInput({ text }: { text: string | null | undefined }) {
  return <details id="original-input" open><summary>Original input</summary><pre className="whitespace-pre-wrap break-words">{text ?? "Original input unavailable for this revision."}</pre></details>;
}
export function RequirementLink({ id, requirements, onOpenTask }: { id: string; requirements: readonly CanonicalRequirement[]; onOpenTask?: ViewerProps["onOpenTask"] }) {
  const requirement = requirements.find((entry) => entry.id === id);
  return <span>{onOpenTask ? <Button variant="link" size="xsmall" onClick={() => onOpenTask(id)}>{id}</Button> : <code>{id}</code>} — {requirement?.text ?? "Unresolved requirement"}</span>;
}

/** Fragment links stay inside the document instead of changing the application hash route. */
export function navigateArtifactAnchor(event: MouseEvent<HTMLAnchorElement>, id: string) {
  event.preventDefault();
  const element = document.getElementById(id);
  if (element instanceof HTMLDetailsElement) element.open = true;
  element?.scrollIntoView?.({ block: "nearest" });
}

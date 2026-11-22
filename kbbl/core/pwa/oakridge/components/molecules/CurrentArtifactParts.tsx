import type { MouseEvent } from "react";
import type { CanonicalRequirement } from "../../lib/current-contract";
import type { ViewerProps } from "../../artifactRegistry";
import { Button } from "../../../components/atoms/Button";
export function CurrentParseFailure({ body, detail }: { body: unknown; detail: string }) {
  return <section><p role="alert">Could not read this artifact: {detail}</p><pre className="whitespace-pre-wrap break-words">{JSON.stringify(body, null, 2)}</pre></section>;
}
/** A tabbed viewer passes `onOpenOriginalInput` to switch to its Original input section; otherwise the link scrolls within the page. */
export function SourceReferences({ refs, onOpenOriginalInput }: { refs: readonly string[]; onOpenOriginalInput?: () => void }) {
  const openOriginalInput = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpenOriginalInput) return navigateArtifactAnchor(event, "original-input");
    event.preventDefault();
    onOpenOriginalInput();
  };
  return <ul>{refs.map((ref, index) => <li key={index}><a className="underline" href={/^https?:\/\//i.test(ref) ? ref : "#original-input"} onClick={/^https?:\/\//i.test(ref) ? undefined : openOriginalInput}>{ref}</a></li>)}</ul>;
}
export function selectOriginalSpec(inputs: unknown): string | null {
  return inputs !== null && typeof inputs === "object" && "original_spec" in inputs && typeof inputs.original_spec === "string"
    ? inputs.original_spec : null;
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

import { useEffect, type MouseEvent } from "react";
import type { DefinitionSelection } from "../../lib/hash";

interface DefinitionAnchorOptions {
  selection: DefinitionSelection | null;
  isReady: boolean;
  onNavigate: (href: string) => void;
}

function revealDefinitionAnchor(target: string | undefined): void {
  if (!target) return;
  const element = document.getElementById(target);
  if (!element) return;
  if (element instanceof HTMLDetailsElement) element.open = true;
  element.scrollIntoView?.();
  element.focus();
}

/** Hash routes contain an optional second fragment for a declaration anchor. */
export function useDefinitionAnchors({
  selection: routeSelection,
  isReady,
  onNavigate,
}: DefinitionAnchorOptions) {
  const selectedPath =
    routeSelection?.kind === "stage" ? routeSelection.stage : routeSelection?.path;
  const [path, target] = selectedPath?.split("#") ?? [];
  const selection =
    routeSelection && path
      ? routeSelection.kind === "stage"
        ? { kind: "stage" as const, stage: path }
        : { kind: "unit" as const, path }
      : routeSelection;

  useEffect(() => {
    if (isReady) revealDefinitionAnchor(target);
  }, [target, isReady]);

  function onClick(event: MouseEvent<HTMLElement>): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    const href = anchor?.getAttribute("href");
    if (!href?.startsWith("#oakridge/defs/")) return;
    event.preventDefault();
    onNavigate(href);
  }

  return { selection, onClick };
}

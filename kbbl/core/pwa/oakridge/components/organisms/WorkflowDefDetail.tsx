import { useEffect } from "react";
import { StageInspector } from "./StageInspector";
import { useWorkflowDef } from "../../hooks/useWorkflowDef";
import { Button } from "../../../components/atoms/Button";
import type { DefinitionSelection } from "../../../lib/hash";
import { selectDefinitionOverview } from "../../lib/definition-overview";
import { DefinitionOverview, DefinitionSelectionSummary } from "../molecules/DefinitionOverview";
import { DefinitionGraph } from "../molecules/DefinitionGraph";
import { DefinitionRawView } from "../molecules/DefinitionRawView";

interface WorkflowDefDetailProps {
  readonly definitionId: string; readonly selection: DefinitionSelection | null;
  readonly onNavigate: (href: string) => void; readonly onBack: () => void;
}
export function WorkflowDefDetail({ definitionId, selection: routeSelection, onNavigate, onBack }: WorkflowDefDetailProps) {
  const query = useWorkflowDef(definitionId);
  const selectedPath = routeSelection?.kind === "stage" ? routeSelection.stage : routeSelection?.path;
  const [path, target] = selectedPath?.split("#") ?? [];
  const selection = routeSelection && path ? routeSelection.kind === "stage"
    ? { kind: "stage" as const, stage: path } : { kind: "unit" as const, path } : routeSelection;
  useEffect(() => {
    if (!target || !query.data) return;
    const element = document.getElementById(target);
    if (element instanceof HTMLDetailsElement) element.open = true;
    element?.scrollIntoView?.();
    element?.focus();
  }, [target, query.data]);
  if (query.isPending) return <div data-testid="or-def-detail-loading">Loading definition…</div>;
  if (query.isError || !query.data) return <div role="alert" data-testid="or-def-detail-error">{query.error?.message ?? "Definition unavailable"}</div>;
  const definition = query.data;
  const overview = selectDefinitionOverview(definition);
  return <div className="or-page or-page--wide" data-testid="or-def-detail" onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    const href = anchor?.getAttribute("href");
    if (href?.startsWith("#oakridge/defs/")) {
      event.preventDefault();
      const [route, target] = href.split("#").slice(1);
      onNavigate(`#${route}`);
      if (target) requestAnimationFrame(() => {
        const element = document.getElementById(target);
        if (element instanceof HTMLDetailsElement) element.open = true;
        element?.scrollIntoView?.();
        element?.focus();
      });
    }
  }}>
    <Button variant="secondary" onClick={onBack}>← Workflows</Button>
    <h1>Workflow definition</h1>
    <DefinitionOverview overview={overview} />
    <DefinitionGraph overview={overview} definition={definition} selection={selection} />
    <section data-testid="or-def-selection" aria-label="Selected declaration"><DefinitionSelectionSummary overview={overview} selection={selection} /></section>
    <StageInspector definition={definition} selection={selection} />
    <DefinitionRawView key={JSON.stringify(selection)} definition={definition} selection={selection} />
  </div>;
}

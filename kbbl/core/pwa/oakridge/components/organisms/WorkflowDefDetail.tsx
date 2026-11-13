import { useDefinitionAnchors } from "../../hooks/useDefinitionAnchors";
import { StageInspector } from "./StageInspector";
import { useWorkflowDef } from "../../hooks/useWorkflowDef";
import { Button } from "../../../components/atoms/Button";
import type { DefinitionSelection } from "../../../lib/hash";
import { selectDefinitionOverview } from "../../lib/definition-overview";
import { DefinitionOverview, DefinitionSelectionSummary } from "../molecules/DefinitionOverview";
import { DefinitionGraph } from "../molecules/DefinitionGraph";
import { DefinitionRawView } from "../molecules/DefinitionRawView";

interface WorkflowDefDetailProps {
  readonly definitionId: string;
  readonly selection: DefinitionSelection | null;
  readonly onNavigate: (href: string) => void;
  readonly onBack: () => void;
}
export function WorkflowDefDetail({
  definitionId,
  selection: routeSelection,
  onNavigate,
  onBack,
}: WorkflowDefDetailProps) {
  const query = useWorkflowDef(definitionId);
  const { selection, onClick } = useDefinitionAnchors({
    selection: routeSelection,
    isReady: Boolean(query.data),
    onNavigate,
  });
  if (query.isPending) return <div data-testid="or-def-detail-loading">Loading definition…</div>;
  if (query.isError || !query.data)
    return (
      <div role="alert" data-testid="or-def-detail-error">
        {query.error?.message ?? "Definition unavailable"}
      </div>
    );
  const definition = query.data;
  const overview = selectDefinitionOverview(definition);
  return (
    <div className="or-page or-page--wide" data-testid="or-def-detail" onClick={onClick}>
      <Button variant="secondary" onClick={onBack}>
        ← Workflows
      </Button>
      <h1>Workflow definition</h1>
      <DefinitionOverview overview={overview} />
      <DefinitionGraph overview={overview} definition={definition} selection={selection} />
      <section data-testid="or-def-selection" aria-label="Selected declaration">
        <DefinitionSelectionSummary overview={overview} selection={selection} />
      </section>
      <StageInspector definition={definition} selection={selection} />
      <DefinitionRawView
        key={JSON.stringify(selection)}
        definition={definition}
        selection={selection}
      />
    </div>
  );
}

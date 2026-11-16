import { useState } from "react";
import { PageHeader } from "../molecules/PageHeader";
import { TextInput } from "../../../components/atoms/TextInput";
import { selectAbbreviatedDefinitionId } from "../../lib/definition-overview";
import { selectDefinitionStructureSummary } from "../../lib/definition-selection";
import { useDefinitionAnchors } from "../../hooks/useDefinitionAnchors";
import { StageInspector } from "../molecules/StageInspector";
import { useWorkflowDef } from "../../hooks/useWorkflowDef";
import { Button } from "../../../components/atoms/Button";
import type { DefinitionSelection } from "../../../lib/hash";
import { selectDefinitionOverview } from "../../lib/definition-overview";
import { DefinitionOverview } from "../molecules/DefinitionOverview";
import { DefinitionGraph } from "../molecules/DefinitionGraph";
import { DefinitionRawView } from "../molecules/DefinitionRawView";

interface SchemaToggle {
  readonly anchor: string | undefined;
  readonly open: boolean;
}

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
  const anchor = (routeSelection?.kind === "stage" ? routeSelection.stage : routeSelection?.path)?.split("#")[1];
  const [schemaToggle, setSchemaToggle] = useState<SchemaToggle>(() => ({
    anchor, open: anchor?.startsWith("definition-schema-") === true,
  }));
  const isSchemaOpen = schemaToggle.anchor === anchor
    ? schemaToggle.open
    : anchor?.startsWith("definition-schema-") === true;
  // A new route anchor resets the local toggle before its declaration is revealed.
  if (schemaToggle.anchor !== anchor) setSchemaToggle({ anchor, open: isSchemaOpen });
  const [rawOpen, setRawOpen] = useState(false);
  const [showFullId, setShowFullId] = useState(false);
  async function onCopyDefinitionId() {
    try {
      if (!navigator.clipboard?.writeText) { setShowFullId(true); return; }
      await navigator.clipboard.writeText(query.data?.definition_id ?? definitionId);
    } catch { setShowFullId(true); }
  }
  const query = useWorkflowDef(definitionId);
  const { selection: normalizedSelection, onClick } = useDefinitionAnchors({
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
  const selection = normalizedSelection;
  const overview = selectDefinitionOverview(definition);
  return (
    <div className="or-page or-page--wide" data-testid="or-def-detail" onClick={onClick}>
      <PageHeader eyebrow="Settings › Workflows" title={overview.name}
        summary={`${selectAbbreviatedDefinitionId(overview.id)} · ${selectDefinitionStructureSummary(overview)}`}
        backAction={<Button variant="secondary" onClick={onBack}>← Workflows</Button>}
        actions={<>
          <Button variant="secondary" onClick={onCopyDefinitionId}>Copy definition ID</Button>
          <Button variant="secondary" aria-pressed={isSchemaOpen} onClick={() => setSchemaToggle({ anchor, open: !isSchemaOpen })}>Schema</Button>
          <Button variant="secondary" aria-pressed={rawOpen} onClick={() => setRawOpen(!rawOpen)}>Raw definition</Button>
        </>} />
      {showFullId && <div><p role="status">Copy unavailable. Select and copy the full definition ID.</p><TextInput aria-label="Full definition ID" value={overview.id} readOnly autoFocus onFocus={event => event.currentTarget.select()} /></div>}
      {isSchemaOpen && <DefinitionOverview overview={overview} selection={selection} />}
      {rawOpen && <DefinitionRawView definition={definition} selection={selection} />}
      <div data-testid="or-def-split" className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0"><DefinitionGraph key="definition-graph" overview={overview} definition={definition} selection={selection} /></div>
        <div className="min-w-0 lg:overflow-auto"><StageInspector definition={definition} selection={selection} anchor={anchor} /></div>
      </div>
    </div>
  );
}

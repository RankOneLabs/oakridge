import type { DefinitionSelection } from "../../lib/hash";
import { WorkflowDefDetail } from "../components/organisms/WorkflowDefDetail";

interface WorkflowDefDetailViewProps {
  definitionId: string;
  selection?: DefinitionSelection | null;
  onNavigate?: (href: string) => void;
  onBack: () => void;
}

export function WorkflowDefDetailView(props: WorkflowDefDetailViewProps) {
  return <WorkflowDefDetail {...props} selection={props.selection ?? null} onNavigate={props.onNavigate ?? ((href) => { window.location.hash = href; })} />;
}

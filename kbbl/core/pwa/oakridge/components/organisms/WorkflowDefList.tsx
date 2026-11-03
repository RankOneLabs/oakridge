import { useWorkflowDefs } from "../../hooks/useWorkflowDefs";
import type { WorkflowDefSummary } from "../../project-types";
import { Button } from "../../../components/atoms/Button";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { PageHeader } from "../molecules/PageHeader";

interface WorkflowDefListProps { readonly onSelect: (definition: WorkflowDefSummary) => void }
export function WorkflowDefList({ onSelect }: WorkflowDefListProps) {
  const query = useWorkflowDefs();
  return <div className="or-page or-page--wide" data-testid="or-def-list">
    <PageHeader eyebrow="Committed workflows" title="Workflows" summary="Inspect the definitions available to launch." />
    {query.isError && <FeedbackMessage tone="danger" testId="or-def-list-error">{query.error.message}</FeedbackMessage>}
    {query.isPending && <FeedbackMessage testId="or-def-list-loading">Loading definitions…</FeedbackMessage>}
    {query.data?.length === 0 && <FeedbackMessage testId="or-def-list-empty">No launchable definitions found.</FeedbackMessage>}
    <table className="or-data-table w-full text-sm" aria-label="Workflow definitions">
      <thead><tr><th>Name</th><th>Definition ID</th></tr></thead>
      <tbody>{query.data?.map((definition) => <tr key={definition.id} data-testid="or-def-row">
        <td><Button variant="secondary" onClick={() => onSelect(definition)} data-testid="or-def-view-btn">{definition.name}</Button></td>
        <td className="font-mono text-xs">{definition.id}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

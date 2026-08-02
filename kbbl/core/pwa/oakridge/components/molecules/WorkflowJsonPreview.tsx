interface WorkflowJsonPreviewProps {
  json: string;
}

export function WorkflowJsonPreview({ json }: WorkflowJsonPreviewProps) {
  return (
    <aside className="sticky top-4 flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase text-[var(--text-muted)]">JSON Preview (POST body)</span>
      <pre className="max-h-[70vh] overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 font-mono text-xs text-[var(--text-secondary)]" data-testid="or-def-preview">{json}</pre>
    </aside>
  );
}

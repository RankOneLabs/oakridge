import type { DefinitionSummary, GradingDifference } from "../../lib/grading-config";
interface GradingConfigSummaryProps { readonly summary: DefinitionSummary }
export function GradingConfigSummary({ summary }: GradingConfigSummaryProps) {
  return <div className="grid gap-1 text-sm" data-testid="grading-definition-summary">
    <h3 className="font-semibold">{summary.id} · {summary.scope}</h3>
    <p>{summary.text}</p><p>Allowed answers: {summary.allowedValues}</p>
    <p>Targets: {summary.targetsText}</p>
    <p>Evidence: {summary.evidenceText}</p>
    <p>Evaluators: {summary.evaluatorsText}</p>
  </div>;
}
interface GradingConfigDiffProps { readonly differences: readonly GradingDifference[] }
export function GradingConfigDiff({ differences }: GradingConfigDiffProps) {
  return <section aria-label="Draft comparison" className="grid gap-3" data-testid="grading-config-diff"><h2>Local draft compared with latest published version</h2>
    {differences.length === 0 ? <p>No differences.</p> : differences.map((difference, index) => <div key={index} className="rounded border border-[var(--border-muted)] p-3">
      <p>{difference.kind} · definitions.{difference.path.join(".")}</p>
      <pre className="whitespace-pre-wrap break-all">Before: {JSON.stringify(difference.before) ?? "(absent)"}{"\n"}After: {JSON.stringify(difference.after) ?? "(absent)"}</pre>
    </div>)}
  </section>;
}

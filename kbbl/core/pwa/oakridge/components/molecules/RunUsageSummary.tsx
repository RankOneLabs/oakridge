import type { OperatorRunUsage } from "../../operator-contracts/domain/usage";
import { formatUsageDuration, formatUsageTokens, formatUsageUsd, selectUsageBasis, selectUsageCohorts, selectUsageCoverage, selectUsageTotals, selectUsageVerification } from "../../lib/run-usage";

interface Props { usage: OperatorRunUsage }
export function RunUsageSummary({ usage }: Props) {
  const rows = selectUsageCohorts(usage);
  const totals = selectUsageTotals(usage);
  const coverage = selectUsageCoverage(usage);
  const verification = selectUsageVerification(usage);
  const basis = selectUsageBasis(usage.usd_basis);
  return <div className="flex flex-col gap-2 text-sm">
    <div className="overflow-x-auto"><table className="w-full text-left" aria-label="Cohort usage">
      <thead><tr><th>Cohort</th><th>First pass</th><th>Rework</th><th>Agent time</th><th>Human wait</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.unit_id} data-testid="usage-cohort">
        <th scope="row" title={row.unit_id}>{row.label}</th>
        <td>{formatUsageUsd(row.first_pass_usd)} <small>{basis}</small></td>
        <td>{formatUsageUsd(row.rework_usd)} <small>{basis}</small></td>
        <td>{formatUsageDuration(row.agent_ms)}</td>
        <td>{row.approximate && "≈ "}{formatUsageDuration(row.human_wait_ms)}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="m-0" data-testid="usage-totals">Run total: {formatUsageUsd(totals.usd)} <small>{basis}</small> · Rework: {formatUsageUsd(totals.rework.usd)} <small>{basis}</small> · Agent time {formatUsageDuration(totals.agent_ms)} · Human wait {formatUsageDuration(totals.human_wait_ms)} · External wait {formatUsageDuration(totals.external_wait_ms)} · Elapsed {formatUsageDuration(totals.elapsed_ms)}</p>
    <p className="m-0">Tokens: {formatUsageTokens(totals.tokens.total)} total · {formatUsageTokens(totals.tokens.input)} input · {formatUsageTokens(totals.tokens.output)} output · {formatUsageTokens(totals.tokens.cached_read)} cached read · {formatUsageTokens(totals.tokens.cached_write)} cached write · {formatUsageTokens(totals.tokens.thought)} thought</p>
    <p className="m-0" data-testid="usage-coverage">Coverage: {coverage.turns} turns · {coverage.reported} reported · {coverage.partial} partial · {coverage.absent} absent · Cost-unreported sessions: {coverage.cost_unreported_sessions.length} {coverage.cost_unreported_sessions.join(", ")} · Failed sessions: {coverage.failed_session_count}</p>
    {coverage.completeness_warning && <p className="m-0 text-[var(--text-secondary)]" role="status">{coverage.completeness_warning}</p>}
    {verification && <p className="m-0">Verification: {formatUsageUsd(verification.usd)} <small>{selectUsageBasis(verification.usd_basis)}</small></p>}
  </div>;
}

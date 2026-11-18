import type { OperatorRunUsage } from "../../operator-contracts/domain/usage";
import { formatUsageDuration, formatUsageUsd, selectUsageBasis, selectUsageCohorts, selectUsageCoverage, selectUsageStatGroups, type UsageStatGroup } from "../../lib/run-usage";

interface Props { usage: OperatorRunUsage }
export function RunUsageSummary({ usage }: Props) {
  const rows = selectUsageCohorts(usage);
  const groups = selectUsageStatGroups(usage);
  const coverage = selectUsageCoverage(usage);
  const basis = selectUsageBasis(usage.usd_basis);
  return <div className="flex flex-col gap-4 text-sm">
    {coverage.completeness_warning && <p className="m-0 rounded border border-[var(--amber-border)] bg-[var(--amber-bg)] px-3 py-2 text-[var(--amber-fg)]" role="status">{coverage.completeness_warning}</p>}
    {groups.map((group) => <UsageStatGroupSection key={group.key} group={group} />)}
    {coverage.cost_unreported_sessions.length > 0 && <p className="m-0 text-xs text-[var(--text-muted)]" data-testid="usage-cost-unreported">Cost-unreported sessions: {coverage.cost_unreported_sessions.join(", ")}</p>}
    <section aria-label="Cohort usage">
      <h4 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Cohorts <span className="font-normal normal-case tracking-normal">· {basis}</span></h4>
      {rows.length === 0 ? <p className="m-0 text-[var(--text-muted)]">No cohorts yet.</p> : <div className="overflow-x-auto"><table className="w-full max-w-3xl border-collapse text-left tabular-nums">
        <thead className="text-xs text-[var(--text-muted)]"><tr className="border-b border-[var(--border-decorative)]">
          <th className="py-1 pr-3 font-medium">Cohort</th>
          <th className="py-1 pr-3 text-right font-medium">First pass</th>
          <th className="py-1 pr-3 text-right font-medium">Rework</th>
          <th className="py-1 pr-3 text-right font-medium">Agent time</th>
          <th className="py-1 text-right font-medium">Human wait</th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.unit_id} className="border-b border-[var(--border-muted)] last:border-b-0" data-testid="usage-cohort">
          <th scope="row" className="py-1 pr-3 font-medium" title={row.unit_id}>{row.label}</th>
          <td className="py-1 pr-3 text-right">{formatUsageUsd(row.first_pass_usd)}</td>
          <td className="py-1 pr-3 text-right">{formatUsageUsd(row.rework_usd)}</td>
          <td className="py-1 pr-3 text-right">{formatUsageDuration(row.agent_ms)}</td>
          <td className="py-1 text-right">{row.approximate && <span title="Approximate">≈ </span>}{formatUsageDuration(row.human_wait_ms)}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  </div>;
}

function UsageStatGroupSection({ group }: { group: UsageStatGroup }) {
  return <section aria-label={group.label} data-testid={`usage-${group.key}`}>
    <h4 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
      {group.label}{group.note && <span className="font-normal normal-case tracking-normal"> · {group.note}</span>}
    </h4>
    <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
      {group.stats.map((stat) => <div key={stat.label} className="rounded border border-[var(--border-decorative)] bg-[var(--bg-surface)] px-3 py-2">
        <dt className="text-xs text-[var(--text-muted)]">{stat.label}</dt>
        <dd className="m-0 text-base font-semibold tabular-nums text-[var(--text-primary)]">{stat.value}</dd>
        {stat.note && <dd className="m-0 text-xs text-[var(--text-muted)]">{stat.note}</dd>}
      </div>)}
    </dl>
  </section>;
}

import { useMemo } from "react";

import type { EnvelopeEvent } from "../../types";
import { computeMetrics } from "../../lib/events";
import { fmtTokensCompact, fmtDuration, fmtCost } from "../../lib/format";

export function MetricsStrip({ events }: { events: EnvelopeEvent[] }) {
  const m = useMemo(() => computeMetrics(events), [events]);
  if (m.turns === 0) return null;
  const last = m.last;
  // Cache reads are essentially free per Anthropic billing — surface them as
  // a separate stat so a big cache_read number doesn't make the operator
  // think they just burned a million-token turn.
  const lastBilled = last ? last.inT + last.cacheCreate + last.outT : 0;
  const totalBilled = m.totalIn + m.totalCacheCreate + m.totalOut;
  return (
    <details className="metrics-strip">
      <summary className="metrics-summary">
        {last && (
          <span className="metric" title="Last turn input (incl. cache creation) → output tokens">
            <span className="metric-label">last</span>
            <span className="metric-value">
              {fmtTokensCompact(last.inT + last.cacheCreate)}→
              {fmtTokensCompact(last.outT)}
            </span>
          </span>
        )}
        {last && last.dur > 0 && (
          <span className="metric" title="Last turn wall-clock duration">
            <span className="metric-value">{fmtDuration(last.dur)}</span>
          </span>
        )}
        {/* Cost chips render once any turn has completed. Em-dash signals $0 — typically a Claude Max session. */}
        {last && (
          <span
            className="metric"
            title="Last turn cost — delta from previous turn (— = no per-token cost reported by Claude Code; typical on Claude Max)"
          >
            <span className="metric-value">{last.cost > 0 ? fmtCost(last.cost) : "—"}</span>
          </span>
        )}
        <span className="metric-sep">·</span>
        <span className="metric" title="Cumulative billed tokens across all turns this session">
          <span className="metric-label">session</span>
          <span className="metric-value">{fmtTokensCompact(totalBilled)}</span>
        </span>
        <span className="metric" title={`${m.turns} turn${m.turns === 1 ? "" : "s"}`}>
          <span className="metric-value">
            {m.turns} turn{m.turns === 1 ? "" : "s"}
          </span>
        </span>
        <span
          className="metric"
          title="Session cost — cumulative across all turns (— = no per-token cost reported by Claude Code; typical on Claude Max)"
        >
          <span className="metric-value">{m.totalCost > 0 ? fmtCost(m.totalCost) : "—"}</span>
        </span>
      </summary>
      <div className="metrics-detail">
        {last && (
          <div className="metrics-detail-section">
            <div className="metrics-detail-heading">Last turn</div>
            <dl>
              <dt>input</dt>
              <dd>{last.inT.toLocaleString()}</dd>
              <dt>output</dt>
              <dd>{last.outT.toLocaleString()}</dd>
              <dt>cache create</dt>
              <dd>{last.cacheCreate.toLocaleString()}</dd>
              <dt>cache read</dt>
              <dd>{last.cacheRead.toLocaleString()}</dd>
              <dt>duration</dt>
              <dd>{fmtDuration(last.dur) || "—"}</dd>
              <dt>cost (delta)</dt>
              <dd>{last.cost > 0 ? fmtCost(last.cost) : "—"}</dd>
              <dt>billed</dt>
              <dd>{lastBilled.toLocaleString()}</dd>
            </dl>
          </div>
        )}
        <div className="metrics-detail-section">
          <div className="metrics-detail-heading">Session ({m.turns} turns)</div>
          <dl>
            <dt>input</dt>
            <dd>{m.totalIn.toLocaleString()}</dd>
            <dt>output</dt>
            <dd>{m.totalOut.toLocaleString()}</dd>
            <dt>cache create</dt>
            <dd>{m.totalCacheCreate.toLocaleString()}</dd>
            <dt>cache read</dt>
            <dd>{m.totalCacheRead.toLocaleString()}</dd>
            <dt>duration</dt>
            <dd>{fmtDuration(m.totalDur) || "—"}</dd>
            <dt>cost (cumulative)</dt>
            <dd>{m.totalCost > 0 ? fmtCost(m.totalCost) : "—"}</dd>
            <dt>billed</dt>
            <dd>{totalBilled.toLocaleString()}</dd>
          </dl>
        </div>
      </div>
    </details>
  );
}

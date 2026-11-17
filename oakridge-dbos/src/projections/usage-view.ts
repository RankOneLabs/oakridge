import type { RunUsage, KbblUsage, AttributedTurn, UsageAttempt } from "../domain/usage";
import type { RunRead } from "../storage/read-store";
import { attributeUsage, attemptKey } from "./usage-attribution";
import { costDeltas, nullableSum, sumUsage, tokensFor } from "./usage-cost";
import { classifyRework } from "./usage-rework";
import { elapsedTime, reviewTimes, turnDuration } from "./usage-time";
export function selectRunUsage(read: RunRead, sessions: readonly KbblUsage[], failed_sessions: string[], verification: RunUsage["verification"]): RunUsage {
  const owned = attributeUsage(read.attempts, sessions);
  const deltas = costDeltas(sessions, owned);
  const rework = classifyRework(read.attempts, read.revisions);
  const turns = owned.map((o): AttributedTurn => ({ sid: o.sid, turn_key: o.turn.turn_key, source: o.turn.source, kind: o.kind, status: o.turn.status,
    coverage: o.turn.usage?.status ?? "absent", tokens: tokensFor(o.turn), ...turnDuration(o.turn),
    usd: nullableSum(deltas.filter((d) => d.owner === o && !d.background).map((d) => d.usd)) }));
  const attempts = read.attempts.map((a): UsageAttempt => {
    const indices = owned.flatMap((o,i) => o.attempt && attemptKey(o.attempt) === attemptKey(a) ? [i] : []);
    const assigned = indices.map((i) => turns[i]!);
    const costs = deltas.filter((d) => d.owner?.attempt && attemptKey(d.owner.attempt) === attemptKey(a));
    return { action_id: a.action_id, seq: a.seq, worker: a.worker, rework: rework.has(attemptKey(a)), turns: assigned,
      ...sumUsage(assigned), usd: nullableSum(costs.map((d) => d.usd)), background: { usd: nullableSum(costs.filter((d) => d.background).map((d) => d.usd)) } };
  });
  const reviews = reviewTimes(read);
  const units = read.units.map((u) => {
    const unitAttempts = attempts.filter((a) => read.attempts.some((r) => r.unit_id === u.id && attemptKey(r) === attemptKey(a)));
    return { unit_id: u.id, stage: u.stage, collection_key: u.collection_key, attempts: unitAttempts,
      first_pass: sumUsage(unitAttempts.filter((a) => !a.rework)), rework: sumUsage(unitAttempts.filter((a) => a.rework)),
      reviews: reviews.filter((r) => r.unit_id === u.id).map(({ unit_id, kind, ...review }) => review) };
  });
  return { run_id: read.run.id, usd_basis: "list_price_equivalent", totals: { ...sumUsage(turns), usd: nullableSum(deltas.map((d) => d.usd)),
    human_wait_ms: reviews.filter((r) => r.kind === "human").reduce((s,r) => s+r.wait_ms,0), external_wait_ms: reviews.filter((r) => r.kind === "external").reduce((s,r) => s+r.wait_ms,0), elapsed_ms: elapsedTime(read) },
    rework: sumUsage(attempts.filter((a) => a.rework)), verification, units, unattributed: turns.filter((_,i) => owned[i]?.attempt === null),
    coverage: { turns: turns.length, reported: turns.filter((t) => t.coverage === "reported").length, partial: turns.filter((t) => t.coverage === "partial").length,
      absent: turns.filter((t) => t.coverage === "absent").length, failed_sessions,
      cost_unreported_sessions: [...new Set([...failed_sessions, ...sessions.filter((s) => !s.readings.some((r) => r.cost_amount !== null && r.cost_currency === "USD")).map((s) => s.sid)])] } };
}

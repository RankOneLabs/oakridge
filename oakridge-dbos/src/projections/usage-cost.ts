import type { KbblUsage, UsageTokens, UsageAmount, UsageTurn } from "../domain/usage";
import { turnTime, type OwnedTurn } from "./usage-attribution";
export const nullableSum = (values: readonly (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a,b) => a+b, 0) : null;
};
export function tokensFor(turn: UsageTurn): UsageTokens {
  const u = turn.usage?.status === "absent" ? null : turn.usage;
  return { input: u?.input_tokens ?? null, output: u?.output_tokens ?? null, cached_read: u?.cached_read_tokens ?? null,
    cached_write: u?.cached_write_tokens ?? null, thought: u?.thought_tokens ?? null, total: u?.total_tokens ?? null };
}
export function sumUsage(values: readonly UsageAmount[]): UsageAmount {
  const field = (key: keyof UsageTokens) => nullableSum(values.map((v) => v.tokens[key]));
  return { tokens: { input: field("input"), output: field("output"), cached_read: field("cached_read"), cached_write: field("cached_write"), thought: field("thought"), total: field("total") },
    usd: nullableSum(values.map((v) => v.usd)), agent_ms: nullableSum(values.map((v) => v.agent_ms)) };
}
export interface CostDelta { owner: OwnedTurn | null; usd: number; background: boolean }
export function costDeltas(sessions: readonly KbblUsage[], turns: readonly OwnedTurn[]): CostDelta[] {
  return sessions.flatMap((session) => {
    const previous = new Map<number, number>();
    return [...session.readings].sort((a,b) => a.seq-b.seq).flatMap((r): CostDelta[] => {
      if (r.cost_amount === null || r.cost_currency !== "USD") return [];
      const last = previous.get(r.process_seq);
      previous.set(r.process_seq, r.cost_amount);
      const usd = last === undefined || r.cost_amount < last ? r.cost_amount : r.cost_amount-last;
      const background = r.autonomous || r.active_turn_key === null;
      const candidates = turns.filter((t) => t.sid === session.sid);
      const owner = background ? candidates.filter((t) => turnTime(t.turn) <= Date.parse(r.received_at)).sort((a,b) => turnTime(b.turn)-turnTime(a.turn))[0]
        : candidates.find((t) => t.turn.turn_key === r.active_turn_key);
      return [{ owner: owner ?? null, usd, background }];
    });
  });
}

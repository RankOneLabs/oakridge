import type { RunRead } from "../storage/read-store";

export type ActionHistoryEntry = never;

export function selectOperatorActions(_read: RunRead): readonly ActionHistoryEntry[] {
  return [];
}

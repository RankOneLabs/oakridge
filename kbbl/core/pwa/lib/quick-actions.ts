import type { Skill } from "../../runtime-interface";

export const DEFAULT_QUICK_ACTION_KEYS = ["mcp:gated-review:get_review_round", "/compact"];

export function quickActionKey(skill: Skill): string {
  return skill.id.startsWith("agent-command:") ? "/" + skill.id.slice("agent-command:".length) : skill.name;
}

export function selectQuickActions(available: Skill[], keys: string[]): Skill[] {
  const selected = new Set(keys);
  return available.filter((skill) => selected.has(quickActionKey(skill)));
}

/** Toggle one name-based preference without changing the other choices. */
export function selectToggledQuickActionKeys(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key];
}

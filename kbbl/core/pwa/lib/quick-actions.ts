import type { Skill } from "../../runtime-interface";

export const DEFAULT_QUICK_ACTION_KEYS = ["mcp:gated-review:get_review_round", "/compact"];

export function quickActionKey(skill: Skill): string {
  return skill.id.startsWith("agent-command:") ? "/" + skill.id.slice("agent-command:".length) : skill.name;
}

const QUICK_ACTION_ICONS: Readonly<Record<string, string>> = {
  "/compact": "⇊",
  "mcp:gated-review:get_review_round": "⟳",
};

/** The glyph a quick action shows in place of its name: a known icon, else the label's first letter. */
export function selectQuickActionIcon(skill: Skill, label: string): string {
  return QUICK_ACTION_ICONS[quickActionKey(skill)] ?? label.charAt(0).toUpperCase();
}

export function selectQuickActions(available: Skill[], keys: string[]): Skill[] {
  const selected = new Set(keys);
  return available.filter((skill) => selected.has(quickActionKey(skill)));
}

/** Toggle one name-based preference without changing the other choices. */
export function selectToggledQuickActionKeys(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key];
}

export type SkillButtonState = "idle" | "disabled" | "collecting" | "confirming" | "dispatching";

/** Accessible name for an icon-only skill button: its name plus what the hidden text would have announced. */
export function selectSkillButtonLabel(name: string, skill: Pick<Skill, "args">, state: SkillButtonState): string {
  const notes = [
    skill.args.length > 0 ? "requires input" : null,
    state === "confirming" ? "tap again to confirm" : null,
    state === "dispatching" ? "dispatching" : null,
  ].filter((note): note is string => note !== null);
  return [name, ...notes].join(", ");
}

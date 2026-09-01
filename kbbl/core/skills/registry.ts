import type { Skill } from "./types";
import type { KbblConfig } from "../config";
import { gatedReviewSkills } from "./gated-review";
import { FIXTURE_SKILLS } from "./fixtures";

/**
 * App-owned skill aggregation for one agent profile (§16.2). The legacy
 * runtime skill probes are gone with the provider adapters; the sources
 * are kbbl's own: the gated-review shortcuts (or the fixture set when
 * config.skills.fixtures is on), filtered by visibility and the global
 * hidden denylist, annotated with the confirm gate. Agent-provided slash
 * commands are a separate source the PWA reads from the session's
 * `commands` UI events — they never pass through this registry.
 */
export function aggregateSkillsForProfile(
  profileId: string,
  config: KbblConfig,
): Skill[] {
  const raw = config.skills.fixtures
    ? FIXTURE_SKILLS.filter((skill) => skill.backend === profileId)
    : gatedReviewSkills(profileId);

  const visible = raw.filter((skill) => skill.user_invocable !== false);
  const hiddenSet = new Set(config.skills.hidden);
  const filtered =
    hiddenSet.size === 0
      ? visible
      : visible.filter((skill) => !hiddenSet.has(skill.name));
  const confirmNames = new Set(config.skills.confirm);
  return filtered.map((skill) => ({
    ...skill,
    confirm: confirmNames.has(skill.name),
  }));
}

import type { Skill } from "./types";
import type { Session } from "../session/session";
import type { RuntimeRegistry } from "../runtime";
import type { KbblConfig } from "../config";
import { FIXTURE_SKILLS } from "./fixtures";

export interface SkillAggregator {
  aggregate(session: Session): Promise<Skill[]>;
}

/**
 * Apply the global skill-name denylist. Called after user_invocable filtering
 * so hidden= operates on the post-filter visible list only.
 * Takes `session` as first arg so a per-session policy is a non-breaking change.
 */
export function filterSkillsForSession(
  _session: Session,
  skills: Skill[],
  hidden: string[],
): Skill[] {
  if (hidden.length === 0) return skills;
  const hiddenSet = new Set(hidden);
  return skills.filter((s) => !hiddenSet.has(s.name));
}

export function buildSkillRegistry({
  registry,
  config,
}: {
  registry: RuntimeRegistry | undefined;
  config: KbblConfig;
}): SkillAggregator {
  async function aggregate(session: Session): Promise<Skill[]> {
    let raw: Skill[];

    if (config.skills.fixtures) {
      raw = FIXTURE_SKILLS.filter((s) => s.backend === session.runtimeId);
    } else {
      const runtime = registry?.runtimes.get(session.runtimeId);
      if (!runtime?.discoverSkills) return [];

      const handle = {
        sessionId: session.oakridgeSid,
        runtimeSid: session.currentCcSid,
        resolvedModel: session.currentObservedModel,
      };

      try {
        raw = await runtime.discoverSkills(handle);
      } catch {
        return [];
      }
    }

    const visible = raw.filter((s) => s.user_invocable !== false);
    const filtered = filterSkillsForSession(session, visible, config.skills.hidden);
    const confirmNames = new Set(config.skills.confirm);
    return filtered.map((s) => ({ ...s, confirm: confirmNames.has(s.name) }));
  }

  return { aggregate };
}

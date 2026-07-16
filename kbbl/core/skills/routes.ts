import type { Hono } from "hono";

import { SessionNotReadyError } from "../session/session";
import { isValidSid } from "../server/handlers/per-sid";
import type { SessionManager } from "../session/session-manager";
import type { RuntimeRegistry } from "../runtime";
import type { KbblConfig } from "../config";
import { buildSkillRegistry } from "./registry";

export interface SkillRoutesDeps {
  manager: SessionManager;
  registry: RuntimeRegistry | undefined;
  config: KbblConfig;
}

export function mountSkillsRoutes(app: Hono, deps: SkillRoutesDeps): void {
  const { manager, registry, config } = deps;
  const aggregator = buildSkillRegistry({ registry, config });

  // GET /:sid/skills — returns visible+permitted Skill[] (possibly empty).
  // Always 200: the rail degrades to an empty list rather than an error banner.
  // Only a malformed sid shape returns 400; unknown/not-live sessions return [].
  app.get("/:sid/skills", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);

    const session = manager.get(sid);
    if (!session || session.status !== "live") return c.json([]);

    const skills = await aggregator.aggregate(session);
    return c.json(skills);
  });

  // POST /:sid/skills/invoke — formats and submits a skill invocation via
  // session.writeInput(), tagging slash-prefixed triggers for the runtime's
  // native command parser. Returns a submission ack only (no result envelope).
  app.post("/:sid/skills/invoke", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);

    const session = manager.get(sid);
    if (!session) return c.json({ error: "unknown session" }, 404);
    // Reject non-live sessions early with an explicit state error. The rail
    // already disables when status !== "live"; without this guard the invoke
    // falls through to writeInput() and surfaces as a misleading 503.
    if (session.status !== "live") {
      return c.json({ error: "session not live" }, 409);
    }

    let body: { skill_id?: unknown; args?: unknown };
    try {
      body = (await c.req.json()) as { skill_id?: unknown; args?: unknown };
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    if (typeof body.skill_id !== "string" || body.skill_id.length === 0) {
      return c.json({ error: "skill_id must be a non-empty string" }, 400);
    }
    const skillId = body.skill_id;

    if (
      body.args !== undefined &&
      (typeof body.args !== "object" ||
        body.args === null ||
        Array.isArray(body.args))
    ) {
      return c.json({ error: "args must be an object" }, 400);
    }
    const rawArgs = (body.args ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(rawArgs)) {
      if (typeof v !== "string") {
        return c.json({ error: `args.${k} must be a string` }, 400);
      }
    }
    const args = rawArgs as Record<string, string>;

    // Re-aggregate on every invoke — this is the authorization boundary.
    // Re-applying the policy filter here ensures a hidden or stale skill
    // can never be invoked even if the client crafts the id directly.
    const skills = await aggregator.aggregate(session);
    const skill = skills.find((s) => s.id === skillId);
    if (!skill) return c.json({ error: "unknown or hidden skill" }, 404);

    // Validate required args before touching the runtime.
    for (const argSpec of skill.args) {
      if (argSpec.required && !args[argSpec.key]?.trim()) {
        return c.json({ error: `missing required arg: ${argSpec.key}` }, 400);
      }
    }

    const runtime = registry?.runtimes.get(session.runtimeId);
    if (!runtime?.formatSkillInvocation) {
      return c.json(
        { error: "runtime does not support skill invocation formatting" },
        409,
      );
    }

    const trigger = runtime.formatSkillInvocation(skill, args);

    try {
      await session.writeInput(trigger, {
        command: trigger.trimStart().startsWith("/"),
      });
    } catch (err) {
      if (err instanceof SessionNotReadyError) {
        return c.json({ error: "subprocess not ready" }, 503);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `subprocess write failed: ${msg}` }, 503);
    }

    return c.json({ ok: true });
  });
}

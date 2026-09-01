// Skill routes over the ACP session backend (§16.2), mounted on the
// /sessions/:sid/* browser surface. Listing degrades to [] (the rail
// hides rather than erroring); invocation formats the selection as agent
// input and submits it as an operator turn — the live model sees the
// steering request and owns the actual tool call.

import type { Hono } from "hono";

import { isValidSid } from "../server/handlers/per-sid";
import type { AcpSessionService } from "../acp/session-service";
import type { KbblConfig } from "../config";
import { aggregateSkillsForProfile } from "./registry";
import { formatSkillInvocation } from "./format";

export interface SkillRoutesDeps {
  acp: AcpSessionService;
  config: KbblConfig;
}

export function mountSkillsRoutes(app: Hono, deps: SkillRoutesDeps): void {
  const { acp, config } = deps;

  // GET /sessions/:sid/skills — visible+permitted Skill[] (possibly empty).
  // Always 200 for a well-formed sid: unknown or closed sessions return []
  // so the rail degrades to hidden instead of an error banner.
  app.get("/sessions/:sid/skills", (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);

    const session = acp.getSession(sid);
    if (!session || session.status === "ended" || session.status === "fenced" || session.status === "failed") {
      return c.json([]);
    }
    return c.json(aggregateSkillsForProfile(session.agent_profile, config));
  });

  // POST /sessions/:sid/skills/invoke — format the selection and submit it
  // through the ACP input path. A busy session answers 409 exactly like
  // typed operator input (operator turns never queue, §11.3).
  app.post("/sessions/:sid/skills/invoke", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);

    const session = acp.getSession(sid);
    if (!session) return c.json({ error: "unknown session" }, 404);

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
    for (const [key, value] of Object.entries(rawArgs)) {
      if (typeof value !== "string") {
        return c.json({ error: `args.${key} must be a string` }, 400);
      }
    }
    const args = rawArgs as Record<string, string>;

    // Re-aggregate on every invoke — this is the authorization boundary.
    // Re-applying the policy filter here ensures a hidden or stale skill
    // can never be invoked even if the client crafts the id directly.
    const skills = aggregateSkillsForProfile(session.agent_profile, config);
    const skill = skills.find((entry) => entry.id === skillId);
    if (!skill) return c.json({ error: "unknown or hidden skill" }, 404);

    // Validate required args before touching the session.
    for (const argSpec of skill.args) {
      if (argSpec.required && !args[argSpec.key]?.trim()) {
        return c.json({ error: `missing required arg: ${argSpec.key}` }, 400);
      }
    }

    const trigger = formatSkillInvocation(skill, args);
    const sent = await acp.sendInput(sid, trigger);
    if (!sent.ok) {
      const status =
        sent.error.code === "session_not_found"
          ? 404
          : sent.error.code === "session_busy" ||
              sent.error.code === "session_fenced"
            ? 409
            : 503;
      return c.json({ error: sent.error.detail, code: sent.error.code }, status);
    }
    return c.json({ ok: true });
  });
}

import type { Hono } from "hono";

import { SafirHttpError } from "../../safir/client";
import type { SafirClient } from "../../safir/client";
import type { PermissionRules } from "../../safir/types";
import type { SessionManager } from "../../session/session-manager";
import { isValidSid } from "./per-sid";

export interface MountPermissionRoutesDeps {
  manager: SessionManager;
  safirClient: SafirClient;
}

export function mountPermissionRoutes(
  app: Hono,
  deps: MountPermissionRoutesDeps,
): void {
  const { manager, safirClient } = deps;

  /**
   * POST /:sid/permission/approve-for-task
   *
   * Persists an auto-approve rule to the session's task default profile so
   * future sessions on the same task also auto-approve the tool call.
   *
   * Body: { tool: string, input_match?: PermissionRules["auto_approve"][number]["input_match"] }
   *
   * 422 if the session has no taskId.
   * 404 if the sid or task is unknown.
   */
  app.post("/:sid/permission/approve-for-task", async (c) => {
    const sid = c.req.param("sid");
    if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);

    const session = manager.get(sid);
    if (!session) return c.json({ error: "session not found" }, 404);

    if (session.taskId === undefined) {
      return c.json(
        { error: "session is not task-bound; assign it to a task first" },
        422,
      );
    }
    const taskId = session.taskId;

    let body: { tool?: unknown; input_match?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body.tool !== "string" || body.tool.length === 0) {
      return c.json({ error: "tool must be a non-empty string" }, 400);
    }
    const tool = body.tool;
    const inputMatch = body.input_match as
      | PermissionRules["auto_approve"][number]["input_match"]
      | undefined;

    const newRule: PermissionRules["auto_approve"][number] = inputMatch
      ? { tool, input_match: inputMatch }
      : { tool };

    let task: Awaited<ReturnType<SafirClient["getTask"]>>;
    try {
      task = await safirClient.getTask(taskId);
    } catch (err) {
      if (err instanceof SafirHttpError && err.status === 404) {
        return c.json({ error: "task not found" }, 404);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `could not fetch task: ${msg}` }, 502);
    }

    let updatedProfile: Awaited<ReturnType<SafirClient["getPermissionProfile"]>>;

    const existingProfileId = task.default_permission_profile_id;
    let seedRules: PermissionRules | undefined;
    if (existingProfileId != null) {
      let existing: Awaited<ReturnType<SafirClient["getPermissionProfile"]>>;
      try {
        existing = await safirClient.getPermissionProfile(existingProfileId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `could not fetch profile: ${msg}` }, 502);
      }

      if (!existing.is_seed) {
        // Inline profile exists — append new rule (de-duplicate by tool name)
        const existingRules = existing.rules.auto_approve.filter(
          (r) => r.tool !== tool,
        );
        const mergedAutoApprove = [...existingRules, newRule];
        try {
          updatedProfile = await safirClient.updatePermissionProfile(
            existing.id,
            { rules: { ...existing.rules, auto_approve: mergedAutoApprove } },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return c.json({ error: `could not update profile: ${msg}` }, 502);
        }
        session.setPermissionProfile(updatedProfile);
        return c.json(updatedProfile, 200);
      }
      // Falls through: existing profile is a seed → create new inline profile
      seedRules = existing.rules;
    }

    // No profile or seed profile: create a new inline profile for this task.
    const baseRules: PermissionRules = seedRules
      ? {
          ...seedRules,
          auto_approve: seedRules.auto_approve.filter((r) => r.tool !== tool),
          deny: seedRules.deny.filter((t) => t !== tool),
        }
      : { auto_approve: [], always_prompt: [], deny: [] };
    const inlineName = `task-${taskId}-inline`;
    try {
      updatedProfile = await safirClient.createPermissionProfile({
        name: inlineName,
        description: `Auto-created for "approve for task" on task #${taskId}`,
        rules: { ...baseRules, auto_approve: [...baseRules.auto_approve, newRule] },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `could not create profile: ${msg}` }, 502);
    }

    try {
      await safirClient.setTaskDefaultPermissionProfile(taskId, updatedProfile.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `could not assign profile to task: ${msg}` }, 502);
    }

    session.setPermissionProfile(updatedProfile);
    return c.json(updatedProfile, 200);
  });
}

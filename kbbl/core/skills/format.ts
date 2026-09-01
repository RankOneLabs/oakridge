// Skill-invocation formatting (§16.2). Pure, synchronous, provider-neutral:
// MCP rail selections become a normal-text steering request (the live model
// sees the request and owns the actual tool call); everything else becomes
// a slash trigger — `/<name>` + positional args (ascending numeric key
// order) + named args, space-joined. Ported from the deleted claude-code
// adapter's formatter so the agent-facing text stays identical.

import { formatMcpSkillRequest } from "./gated-review";
import type { Skill } from "./types";

export function formatSkillInvocation(
  skill: Skill,
  args: Record<string, string>,
): string {
  const mcpRequest = formatMcpSkillRequest(skill, args);
  if (mcpRequest !== null) return mcpRequest;

  const numericParts = Object.entries(args)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10))
    .map(([, value]) => value);
  const namedParts = Object.entries(args)
    .filter(([key]) => !/^\d+$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
  const allParts = [...numericParts, ...namedParts].filter(
    (value) => value.length > 0,
  );
  return allParts.length > 0
    ? `/${skill.name} ${allParts.join(" ")}`
    : `/${skill.name}`;
}

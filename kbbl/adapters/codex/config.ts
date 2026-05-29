import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ApprovalPolicy } from "./protocol/generated/types";

const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "untrusted";

const APPROVAL_POLICY_LINE =
  /^\s*(approval_policy|ask_for_approval)\s*=\s*"([^"]+)"\s*(?:#.*)?$/;

function isApprovalPolicy(value: string): value is ApprovalPolicy {
  return value === "never" || value === "untrusted" || value === "on-request" || value === "always";
}

export function parseCodexApprovalPolicy(contents: string): ApprovalPolicy | null {
  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break;

    const match = rawLine.match(APPROVAL_POLICY_LINE);
    if (!match) continue;
    return isApprovalPolicy(match[2]) ? match[2] : null;
  }
  return null;
}

export function loadCodexApprovalPolicy(
  configPath = join(homedir(), ".codex", "config.toml"),
): ApprovalPolicy {
  try {
    const contents = readFileSync(configPath, "utf8");
    return parseCodexApprovalPolicy(contents) ?? DEFAULT_APPROVAL_POLICY;
  } catch {
    return DEFAULT_APPROVAL_POLICY;
  }
}

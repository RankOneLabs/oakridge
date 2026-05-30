import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ApprovalPolicy } from "./protocol/generated/types";
export type { ApprovalPolicy } from "./protocol/generated/types";

const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "untrusted";

const APPROVAL_POLICY_LINE =
  /^\s*(approval_policy|ask_for_approval)\s*=\s*"([^"]+)"\s*(?:#.*)?$/;
const PROFILE_LINE = /^\s*profile\s*=\s*"([^"]+)"\s*(?:#.*)?$/;
const SECTION_LINE = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
const TRUST_LEVEL_LINE = /^\s*trust_level\s*=\s*"([^"]+)"\s*(?:#.*)?$/;

const APPROVAL_POLICIES = {
  never: true,
  untrusted: true,
  "on-request": true,
  always: true,
} satisfies Record<ApprovalPolicy, true>;

function isApprovalPolicy(value: string): value is ApprovalPolicy {
  return Object.prototype.hasOwnProperty.call(APPROVAL_POLICIES, value);
}

type ConfigSection =
  | { kind: "root" }
  | { kind: "project"; path: string }
  | { kind: "profile"; name: string }
  | { kind: "other" };

interface ProjectPolicy {
  path: string;
  approvalPolicy: ApprovalPolicy | null;
  trustLevel: string | null;
}

interface ParsedApprovalConfig {
  rootPolicy: ApprovalPolicy | null;
  activeProfile: string | null;
  profilePolicies: Map<string, ApprovalPolicy>;
  projectPolicies: ProjectPolicy[];
}

function parseSection(line: string): ConfigSection | null {
  const match = line.match(SECTION_LINE);
  if (!match) return null;
  const name = match[1];
  const project = name.match(/^projects\."(.+)"$/);
  if (project) return { kind: "project", path: project[1] };
  const profile = name.match(/^profiles\.([A-Za-z0-9_-]+)$/);
  if (profile) return { kind: "profile", name: profile[1] };
  const quotedProfile = name.match(/^profiles\."(.+)"$/);
  if (quotedProfile) return { kind: "profile", name: quotedProfile[1] };
  return { kind: "other" };
}

function isInsideOrEqual(parentPath: string, childPath: string): boolean {
  const rel = relative(resolve(parentPath), resolve(childPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function policyFromTrustLevel(trustLevel: string | null): ApprovalPolicy | null {
  if (trustLevel === "trusted") return "never";
  if (trustLevel === "untrusted") return "untrusted";
  return null;
}

function parseCodexApprovalConfig(contents: string): ParsedApprovalConfig {
  let section: ConfigSection = { kind: "root" };
  let rootPolicy: ApprovalPolicy | null = null;
  let activeProfile: string | null = null;
  const profilePolicies = new Map<string, ApprovalPolicy>();
  const projectPolicies = new Map<string, ProjectPolicy>();

  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const parsedSection = parseSection(rawLine);
    if (parsedSection) {
      section = parsedSection;
      if (section.kind === "project" && !projectPolicies.has(section.path)) {
        projectPolicies.set(section.path, {
          path: section.path,
          approvalPolicy: null,
          trustLevel: null,
        });
      }
      continue;
    }

    const policyMatch = rawLine.match(APPROVAL_POLICY_LINE);
    if (policyMatch && isApprovalPolicy(policyMatch[2])) {
      const policy = policyMatch[2];
      if (section.kind === "root") rootPolicy = policy;
      else if (section.kind === "profile") profilePolicies.set(section.name, policy);
      else if (section.kind === "project") {
        projectPolicies.set(section.path, {
          ...(projectPolicies.get(section.path) ?? {
            path: section.path,
            trustLevel: null,
          }),
          approvalPolicy: policy,
        });
      }
      continue;
    }

    const profileMatch = rawLine.match(PROFILE_LINE);
    if (profileMatch && section.kind === "root") {
      activeProfile = profileMatch[1];
      continue;
    }

    const trustMatch = rawLine.match(TRUST_LEVEL_LINE);
    if (trustMatch && section.kind === "project") {
      projectPolicies.set(section.path, {
        ...(projectPolicies.get(section.path) ?? {
          path: section.path,
          approvalPolicy: null,
        }),
        trustLevel: trustMatch[1],
      });
    }
  }

  return {
    rootPolicy,
    activeProfile,
    profilePolicies,
    projectPolicies: [...projectPolicies.values()],
  };
}

function fallbackApprovalPolicy(config: ParsedApprovalConfig): ApprovalPolicy | null {
  const profilePolicy =
    config.activeProfile === null
      ? null
      : config.profilePolicies.get(config.activeProfile) ?? null;
  return config.rootPolicy ?? profilePolicy;
}

export function parseCodexApprovalPolicy(contents: string): ApprovalPolicy | null {
  return fallbackApprovalPolicy(parseCodexApprovalConfig(contents));
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

export function loadCodexApprovalPolicyForWorkdir(
  workdir: string,
  configPath = join(homedir(), ".codex", "config.toml"),
): ApprovalPolicy {
  try {
    const contents = readFileSync(configPath, "utf8");
    const config = parseCodexApprovalConfig(contents);
    const project = config.projectPolicies
      .filter((p) => isInsideOrEqual(p.path, workdir))
      .sort((a, b) => resolve(b.path).length - resolve(a.path).length)[0];
    const fallbackPolicy = fallbackApprovalPolicy(config);
    return (
      project?.approvalPolicy ??
      policyFromTrustLevel(project?.trustLevel ?? null) ??
      fallbackPolicy ??
      DEFAULT_APPROVAL_POLICY
    );
  } catch {
    return DEFAULT_APPROVAL_POLICY;
  }
}

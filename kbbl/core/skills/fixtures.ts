import type { Skill } from "./types";

export const FIXTURE_SKILLS: Skill[] = [
  // 1. CC, user scope, no args — baseline user-invocable skill
  {
    id: "cc-list-tasks",
    name: "list-tasks",
    description: "List all open tasks in the current session",
    backend: "claude-code",
    scope: "user",
    args: [],
    user_invocable: true,
    model_invocable: true,
  },

  // 2. CC, project scope, required + optional args — exercises ArgSheet
  {
    id: "cc-create-pr",
    name: "create-pr",
    description: "Open a pull request for the current branch",
    backend: "claude-code",
    scope: "project",
    args: [
      { key: "title", required: true, hint: "PR title" },
      { key: "body", required: false, hint: "PR description (optional)" },
    ],
    user_invocable: true,
    model_invocable: false,
  },

  // 3. CC, user scope, no args — the confirm-gate demo skill (cohort 6).
  // NOTE: `confirm` is not set here on purpose. buildSkillRegistry() derives it
  // for every skill from config.skills.confirm, so any value set on the fixture
  // would be overwritten. To exercise the confirm badge/gate against the fixtures,
  // add "deploy" to config.skills.confirm.
  {
    id: "cc-deploy",
    name: "deploy",
    description: "Deploy the current build to staging",
    backend: "claude-code",
    scope: "user",
    args: [],
    user_invocable: true,
    model_invocable: false,
  },

  // 4. CC, user scope, user_invocable=false — must be dropped by aggregate()
  {
    id: "cc-internal-collect",
    name: "internal-collect",
    description: "Internal model-only data collection step",
    backend: "claude-code",
    scope: "user",
    args: [],
    user_invocable: false,
    model_invocable: true,
  },

  // 5. Codex, user scope, required arg — covers codex backend + ArgSheet required
  {
    id: "codex-search",
    name: "search",
    description: "Search the codebase using Codex",
    backend: "codex",
    scope: "user",
    args: [{ key: "query", required: true, hint: "Search query" }],
    user_invocable: true,
    model_invocable: true,
  },

  // 6. Codex, project scope, required + optional args — covers codex + project scope
  {
    id: "codex-refactor",
    name: "refactor",
    description: "Refactor a file or module using Codex",
    backend: "codex",
    scope: "project",
    args: [
      { key: "target", required: true, hint: "File or module to refactor" },
      { key: "style", required: false, hint: "Refactoring style hint (optional)" },
    ],
    user_invocable: true,
    model_invocable: false,
  },

  // 7. CC, project scope, no args — second project-scoped skill for variety
  {
    id: "cc-summarize",
    name: "summarize",
    description: "Summarize the current project status",
    backend: "claude-code",
    scope: "project",
    args: [],
    user_invocable: true,
    model_invocable: true,
  },
];

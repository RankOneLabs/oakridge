// AUTO-GENERATED — do not edit.
// Source: legit-biz-club/scripts/generate_dashboard_metadata.py
// Regenerate: cd legit-biz-club && uv run python scripts/generate_dashboard_metadata.py
// CI drift: regenerate then `git diff --exit-code ../lbc-dashboard/src/generated/task_catalog.ts`.
import type { TaskBuiltinDetail, GraderSummary } from "../contracts";

export const BUILTIN_TASK_DETAILS: readonly TaskBuiltinDetail[] = [
  {
    "name": "prose_substrate_thesis",
    "artifact_type": "prose",
    "artifact_filename": "thesis.md",
    "seed_content": "",
    "brief": {
      "target_spec": "Draft a technical blog post (1200-1800 words) explaining oakridge's multi-agent workspace architecture to senior software engineers.\n\nThe architecture is described below. Do NOT invent additional coordination modes, components, or features beyond what's stated.\n\n## The thesis\nSubstrate-mediated coordination: a small group of agents (default 5) works on a shared artifact, each agent reading the artifact's current state and proposing changes. Agents do not message each other \u2014 they read substrate, propose, and a project layer mediates. Coordination cost stays roughly constant as group size grows; direct-messaging architectures grow O(N\u00b2).\n\n## Three layers\n- Agent: long-lived, persistent, has its own model + system prompt + accumulating memory across projects.\n- Project: bounded context, owns one artifact + one brief + one enrolled ensemble. Lifecycle: spawn \u2192 enroll \u2192 iterate \u2192 ship/archive.\n- Workspace: operator control plane.\n\n## Three coordination modes\n- Incremental commits (default): agents take turns proposing changes to the artifact. Mediator applies via OCC; conflicts get a retry budget. Termination: K commits per agent OR content stability.\n- Convergence rounds: when triggered by project config, the mechanism runs N rounds of 'all agents propose, peer proposals exposed as substrate next round.' Two implementations: multi-round (default) and single-round-then-pick.\n- Escalation: if rounds don't converge, a DisagreementSurface picks a winner from residual proposals. Default surface is automated (deterministic stable-ordering by agent_id); operator-in-loop is optional.\n\n## Influences (cite honestly)\n- Hayes-Roth blackboard architecture (1985) \u2014 closest direct ancestor: knowledge sources reading/writing shared workspace, no inter-source messaging.\n- Yunkaporta et al. '(Non-)Human Coordination Dynamics' (2026) \u2014 crystallized peer-collaboration-via-shared-substrate as the architectural pattern.",
      "success_criteria": [
        "explains the substrate-mediated coordination thesis clearly to a software engineer with no prior context",
        "names the three coordination modes accurately (incremental, convergence, escalation) \u2014 does NOT invent others",
        "includes at least one concrete example (a project run, code fragment, or worked scenario)",
        "cites the blackboard ancestor and the Yunkaporta paper",
        "is 1200-1800 words",
        "reads as a technical blog post, not marketing copy"
      ],
      "constraints": [
        "no marketing language",
        "no invented architectures (sequential / parallel / hierarchical are NOT modes in this system)",
        "no fictional code APIs \u2014 if you show code, show pseudocode or explicitly-marked illustrative examples"
      ]
    },
    "model_pool": [
      "claude-sonnet-4-5",
      "gpt-5-mini",
      "gemini-2.5-pro",
      "claude-opus-4-7",
      "gpt-5",
      "gemini-2.5-flash",
      "claude-haiku-4-5"
    ],
    "frame_pool": [
      "precision",
      "skepticism",
      "synthesis",
      "user-empathy",
      "first-principles",
      "concision",
      "voice"
    ],
    "has_grader": true,
    "grader_key": "prose_substrate_thesis",
    "source": "builtin"
  },
  {
    "name": "code_leetcode_longest_substring",
    "artifact_type": "code",
    "artifact_filename": "solution.py",
    "seed_content": "def length_of_longest_substring(s: str) -> int:\n    raise NotImplementedError\n",
    "brief": {
      "target_spec": "Implement `length_of_longest_substring(s: str) -> int` in solution.py.\n\nGiven a string s, return the length of the longest substring without repeating characters.\n\nExamples:\n  'abcabcbb' \u2192 3  (longest: 'abc')\n  'bbbbb'    \u2192 1  (longest: 'b')\n  'pwwkew'   \u2192 3  (longest: 'wke')\n  ''         \u2192 0\n  'au'       \u2192 2\n  ' '        \u2192 1  (single space is one character)\n  'dvdf'     \u2192 3  (longest: 'vdf')\n  'Aa'       \u2192 2  (case-sensitive)\n\nThe function must:\n  - Accept any string including empty, single-character, or whitespace\n  - Return 0 for empty input\n  - Be case-sensitive\n  - Treat Unicode characters as single units\n\nRecommended approach: O(n) sliding window with a dict mapping character \u2192 last-seen index. Brute force O(n\u00b2) also acceptable as long as results are correct.",
      "success_criteria": [
        "function passes all 8 example test cases above",
        "type-checks under strict mypy (no Any in the function signature)"
      ],
      "constraints": [
        "single file, single function \u2014 no helper classes",
        "no third-party imports (typing is fine)",
        "no comments inside the function unless they explain a non-obvious algorithmic choice"
      ]
    },
    "model_pool": [
      "claude-sonnet-4-5",
      "gpt-5",
      "claude-opus-4-7",
      "gemini-2.5-pro",
      "gpt-5-mini",
      "claude-haiku-4-5",
      "gemini-2.5-flash"
    ],
    "frame_pool": [
      "type-safety",
      "test-coverage",
      "minimalism",
      "defensive-programming",
      "performance",
      "readability",
      "explicit-errors"
    ],
    "has_grader": true,
    "grader_key": "code_leetcode_longest_substring",
    "source": "builtin"
  },
  {
    "name": "code_leetcode_trapping_rain_water",
    "artifact_type": "code",
    "artifact_filename": "solution.py",
    "seed_content": "def trap(height: list[int]) -> int:\n    raise NotImplementedError\n",
    "brief": {
      "target_spec": "Implement `trap(height: list[int]) -> int` in solution.py.\n\nGiven n non-negative integers representing an elevation map where the width of each bar is 1, compute how much water it can trap after raining.\n\nExamples:\n  [0,1,0,2,1,0,1,3,2,1,2,1] \u2192 6\n  [4,2,0,3,2,5]             \u2192 9\n  [3,0,2,0,4]               \u2192 7\n  []                        \u2192 0\n  [5]                       \u2192 0\n  [3,3,3]                   \u2192 0\n  [5,0,5]                   \u2192 5\n  [1,2,3,4,5]               \u2192 0  (monotonic increasing traps nothing)\n  [5,4,3,2,1]               \u2192 0  (monotonic decreasing traps nothing)\n\nThe function must:\n  - Accept any list[int] including empty / single-element\n  - Return 0 for empty or single-element input\n  - Handle all-zero, monotonic, flat, and pyramid terrains\n\nRecommended approaches (each is O(n) time; brute-force O(n\u00b2) is also acceptable as long as results are correct):\n  - Two-pointer: maintain left_max / right_max and walk inward\n  - Dynamic programming: prefix-max + suffix-max arrays\n  - Stack-based monotonic decreasing\n  All three are valid; pick whichever is cleanest for you.",
      "success_criteria": [
        "function passes all 11 canonical test cases",
        "type-checks under strict mypy (no Any in the function signature)"
      ],
      "constraints": [
        "single file, single function \u2014 no helper classes",
        "no third-party imports (typing is fine)",
        "no comments inside the function unless they explain a non-obvious algorithmic choice"
      ]
    },
    "model_pool": [
      "claude-sonnet-4-5",
      "gpt-5",
      "claude-opus-4-7",
      "gemini-2.5-pro",
      "gpt-5-mini",
      "claude-haiku-4-5",
      "gemini-2.5-flash"
    ],
    "frame_pool": [
      "type-safety",
      "test-coverage",
      "minimalism",
      "defensive-programming",
      "performance",
      "readability",
      "explicit-errors"
    ],
    "has_grader": true,
    "grader_key": "code_leetcode_trapping_rain_water",
    "source": "builtin"
  },
  {
    "name": "code_leetcode_regex_matching",
    "artifact_type": "code",
    "artifact_filename": "solution.py",
    "seed_content": "def is_match(s: str, p: str) -> bool:\n    raise NotImplementedError\n",
    "brief": {
      "target_spec": "Implement `is_match(s: str, p: str) -> bool` in solution.py.\n\nGiven an input string `s` and a pattern `p`, implement regular expression matching with support for `.` and `*`:\n\n  - `.` matches any single character\n  - `*` matches zero or more of the preceding element\n\nThe matching must cover the ENTIRE input string (not partial).\n\nExamples:\n  is_match('aa', 'a')           \u2192 False  (single 'a' doesn't match 'aa')\n  is_match('aa', 'a*')          \u2192 True   (a* matches one or more 'a')\n  is_match('ab', '.*')          \u2192 True   (.* matches any sequence)\n  is_match('aab', 'c*a*b')      \u2192 True   (c* matches zero c, a* matches aa, b matches b)\n  is_match('mississippi', 'mis*is*p*.') \u2192 False\n  is_match('mississippi', 'mis*is*ip*.') \u2192 True\n  is_match('', '')              \u2192 True\n  is_match('', 'a*')            \u2192 True   (a* matches zero a's)\n  is_match('', '.*')            \u2192 True\n  is_match('a', '')             \u2192 False\n  is_match('a', 'ab*')          \u2192 True   (b* matches zero b's)\n\nThe function must:\n  - Match the ENTIRE input string (e.g., is_match('ab', 'a') is False)\n  - Handle empty `s` and empty `p`\n  - Treat `*` as a quantifier on the IMMEDIATELY preceding token (`a*`, `.*`); `*` never appears as the first character of `p`\n  - Handle nested quantifiers correctly (`a*b*c*` should match many strings including empty)\n  - Handle `.` and `*` in the same pattern correctly\n\nRecommended approaches (both work):\n  - Recursion with memoization: handle '*' by trying both 'consume zero' and 'consume one and recurse' branches\n  - Bottom-up DP on a 2D table: dp[i][j] = does s[:i] match p[:j]\n\nWatch out for: greedy `.*` swallowing too much; off-by-one with trailing `*` patterns; empty-string edge cases.",
      "success_criteria": [
        "function passes all 22 canonical test cases",
        "type-checks under strict mypy (no Any in the function signature)",
        "handles empty-string and empty-pattern edge cases correctly",
        "matches the ENTIRE input (not partial) \u2014 ``is_match('ab', 'a')`` must return False"
      ],
      "constraints": [
        "single file, single function \u2014 no helper classes, but internal recursive helpers / memo dicts are fine",
        "no third-party imports (typing and functools are fine)"
      ]
    },
    "model_pool": [
      "claude-sonnet-4-5",
      "gpt-5",
      "claude-opus-4-7",
      "gemini-2.5-pro",
      "gpt-5-mini",
      "claude-haiku-4-5",
      "gemini-2.5-flash"
    ],
    "frame_pool": [
      "type-safety",
      "test-coverage",
      "minimalism",
      "defensive-programming",
      "performance",
      "readability",
      "explicit-errors"
    ],
    "has_grader": true,
    "grader_key": "code_leetcode_regex_matching",
    "source": "builtin"
  },
  {
    "name": "code_leetcode_median_two_sorted_arrays",
    "artifact_type": "code",
    "artifact_filename": "solution.py",
    "seed_content": "def find_median_sorted_arrays(\n    nums1: list[int], nums2: list[int]\n) -> float:\n    raise NotImplementedError\n",
    "brief": {
      "target_spec": "Implement `find_median_sorted_arrays(nums1: list[int], nums2: list[int]) -> float` in solution.py.\n\nGiven two sorted integer arrays of arbitrary sizes, return the median of the combined sorted array as a float.\n\nExamples:\n  ([1, 3], [2])              \u2192 2.0\n  ([1, 2], [3, 4])           \u2192 2.5\n  ([0, 0], [0, 0])           \u2192 0.0\n  ([], [1])                  \u2192 1.0\n  ([2], [])                  \u2192 2.0\n  ([], [2, 3])               \u2192 2.5\n  ([-5, 3, 6, 12, 15], [-12, -10, -6, -3, 4, 10]) \u2192 3.0\n\nThe function must:\n  - Accept arrays where either or both may be empty (but not both empty)\n  - Return the median as a float (single-element median is still a float)\n  - Handle negative numbers, duplicates, and large arrays (up to ~3\u00d710^6 elements per array)\n  - Run in O(log(min(m, n))) time \u2014 this is graded.\n\nThe performance constraint is real: the grader runs a perf test with combined input size 6\u00d710^6 under a 100ms wall-clock budget timed around your function call. An O(m+n) merge in pure Python takes ~270ms on this input and will exceed the budget by ~2.7x. Recommended approach: binary search on partition position in the smaller array (LeetCode editorial 'Approach 4').\n\nReference: https://leetcode.com/problems/median-of-two-sorted-arrays/",
      "success_criteria": [
        "function passes all 13 canonical correctness test cases",
        "type-checks under strict mypy (no Any in the function signature)",
        "completes the 6\u00d710^6-element perf test within the 100ms function-call budget \u2014 only the O(log(min(m, n))) partition algorithm achieves this"
      ],
      "constraints": [
        "single file, single function \u2014 no helper classes, but internal helpers (e.g., a recursive partition) are fine",
        "no imports needed \u2014 use built-in generics for type hints (``list[int]`` not ``List[int]``); do NOT ``from typing import List``. The seed and target signature use the built-in spelling and mypy strict is configured for it",
        "do not call ``sorted()`` or ``list.sort()`` anywhere in solution.py. The perf grader runs a static AST check on solution.py before the timing test; either function call (canonical spelling) fails the perf dimension regardless of wall-clock time"
      ]
    },
    "model_pool": [
      "claude-sonnet-4-5",
      "gpt-5",
      "claude-opus-4-7",
      "gemini-2.5-pro",
      "gpt-5-mini",
      "claude-haiku-4-5",
      "gemini-2.5-flash"
    ],
    "frame_pool": [
      "type-safety",
      "test-coverage",
      "minimalism",
      "defensive-programming",
      "performance",
      "readability",
      "explicit-errors"
    ],
    "has_grader": true,
    "grader_key": "code_leetcode_median_two_sorted_arrays",
    "source": "builtin"
  }
] as const satisfies readonly TaskBuiltinDetail[];

export const BUILTIN_GRADER_SUMMARIES: readonly GraderSummary[] = [
  {
    "key": "prose_substrate_thesis",
    "label": "Brief judge",
    "supported_artifact_types": [
      "prose"
    ],
    "capabilities": [
      "brief-criteria",
      "llm-judge"
    ],
    "source": "builtin",
    "config_required": false,
    "config_schema": null
  },
  {
    "key": "code_leetcode_longest_substring",
    "label": "LeetCode #3 mechanical grader",
    "supported_artifact_types": [
      "code"
    ],
    "capabilities": [
      "pytest",
      "mypy"
    ],
    "source": "builtin",
    "config_required": false,
    "config_schema": null
  },
  {
    "key": "code_leetcode_trapping_rain_water",
    "label": "LeetCode #42 mechanical grader",
    "supported_artifact_types": [
      "code"
    ],
    "capabilities": [
      "pytest",
      "mypy"
    ],
    "source": "builtin",
    "config_required": false,
    "config_schema": null
  },
  {
    "key": "code_leetcode_regex_matching",
    "label": "LeetCode #10 mechanical grader",
    "supported_artifact_types": [
      "code"
    ],
    "capabilities": [
      "pytest",
      "mypy"
    ],
    "source": "builtin",
    "config_required": false,
    "config_schema": null
  },
  {
    "key": "code_leetcode_median_two_sorted_arrays",
    "label": "LeetCode #4 mechanical grader",
    "supported_artifact_types": [
      "code"
    ],
    "capabilities": [
      "pytest",
      "mypy",
      "perf"
    ],
    "source": "builtin",
    "config_required": false,
    "config_schema": null
  }
] as const satisfies readonly GraderSummary[];

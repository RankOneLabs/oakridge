"""Concrete v1 study targets — real briefs for cells we actually run.

Per the design memo's two-domain v1 test:

- Prose domain: a technical blog post explaining the multi-agent
  workspace architecture itself. The brief carries the architecture
  facts inline so models don't fall back on training-data priors and
  invent coordination modes the system doesn't have.
- Code domain: leetcode-shaped problems with mechanical graders.
  Four targets:
  - longest-substring (#3) — sliding window classic, easy to solve;
    works as a smoke target to verify the grader path runs.
  - trapping-rain-water (#42) — Hard tier, multiple valid approaches
    (two-pointer, DP, stack); enough complexity that cheap models
    partially fail and the rubric has room to discriminate.
  - regex-matching (#10) — Hard tier, ``.`` and ``*`` matching
    against the entire input. Adversarial pattern cases (greedy
    backtracking, empty-pattern corners) push cells across the 0..1
    score range rather than clustering at the ceiling.
  - median-two-sorted-arrays (#4) — Hard tier paired with a
    mechanically-enforced perf budget: an O(m+n) merge passes the
    correctness tests but times out on the perf dimension, while the
    O(log(min(m,n))) partition algorithm scores 1.0 on both. First
    target where the brief's complexity claim is actually graded.

Generic :func:`legit_biz_club.study.targets.prose_target` and
:func:`legit_biz_club.study.targets.code_target` stay as the API
templates with placeholder defaults — useful for harness tests.
This module supplies the real targets with the real briefs the v1
study runs against.
"""
from __future__ import annotations

from legit_biz_club.core.models import Brief
from legit_biz_club.study.targets import (
    TargetConfig,
    code_target,
    prose_target,
)

# --- prose: substrate-mediated coordination thesis -----------------------


_PROSE_SUBSTRATE_THESIS_TARGET_SPEC = (
    "Draft a technical blog post (1200-1800 words) explaining "
    "oakridge's multi-agent workspace architecture to senior "
    "software engineers.\n\n"
    "The architecture is described below. Do NOT invent additional "
    "coordination modes, components, or features beyond what's "
    "stated.\n\n"
    "## The thesis\n"
    "Substrate-mediated coordination: a small group of agents "
    "(default 5) works on a shared artifact, each agent reading "
    "the artifact's current state and proposing changes. Agents "
    "do not message each other — they read substrate, propose, "
    "and a project layer mediates. Coordination cost stays "
    "roughly constant as group size grows; direct-messaging "
    "architectures grow O(N²).\n\n"
    "## Three layers\n"
    "- Agent: long-lived, persistent, has its own model + system "
    "prompt + accumulating memory across projects.\n"
    "- Project: bounded context, owns one artifact + one brief + "
    "one enrolled ensemble. Lifecycle: spawn → enroll → iterate "
    "→ ship/archive.\n"
    "- Workspace: operator control plane.\n\n"
    "## Three coordination modes\n"
    "- Incremental commits (default): agents take turns proposing "
    "changes to the artifact. Mediator applies via OCC; conflicts "
    "get a retry budget. Termination: K commits per agent OR "
    "content stability.\n"
    "- Convergence rounds: when triggered by project config, the "
    "mechanism runs N rounds of 'all agents propose, peer "
    "proposals exposed as substrate next round.' Two "
    "implementations: multi-round (default) and "
    "single-round-then-pick.\n"
    "- Escalation: if rounds don't converge, a DisagreementSurface "
    "picks a winner from residual proposals. Default surface is "
    "automated (deterministic stable-ordering by agent_id); "
    "operator-in-loop is optional.\n\n"
    "## Influences (cite honestly)\n"
    "- Hayes-Roth blackboard architecture (1985) — closest direct "
    "ancestor: knowledge sources reading/writing shared workspace, "
    "no inter-source messaging.\n"
    "- Yunkaporta et al. '(Non-)Human Coordination Dynamics' "
    "(2026) — crystallized peer-collaboration-via-shared-substrate "
    "as the architectural pattern."
)


def prose_substrate_thesis() -> TargetConfig:
    """Real prose target for the v1 study: the architecture thesis post.

    The brief is deliberately long because it has to crowd out the
    model's training-data priors about multi-agent systems. Earlier
    smoke runs against the placeholder brief produced plausible-but-
    wrong invented modes (sequential / parallel / hierarchical, etc.);
    shipping the architecture facts in-line is the simplest fix.

    The :class:`Brief` is built fresh per call: pydantic models'
    list fields (success_criteria, constraints) are mutable, and a
    cached module-level Brief would let an in-place mutation by one
    caller leak to every subsequent caller. Module-level constants
    are limited to immutable strings.

    Default model_pool inherits from :func:`prose_target` (Anthropic +
    OpenAI + Google spread). Override at the call site to pin to one
    provider during cost-conscious smoke runs.
    """
    brief = Brief(
        target_spec=_PROSE_SUBSTRATE_THESIS_TARGET_SPEC,
        success_criteria=[
            "explains the substrate-mediated coordination thesis "
            "clearly to a software engineer with no prior context",
            "names the three coordination modes accurately "
            "(incremental, convergence, escalation) — does NOT "
            "invent others",
            "includes at least one concrete example (a project run, "
            "code fragment, or worked scenario)",
            "cites the blackboard ancestor and the Yunkaporta paper",
            "is 1200-1800 words",
            "reads as a technical blog post, not marketing copy",
        ],
        constraints=[
            "no marketing language",
            "no invented architectures (sequential / parallel / "
            "hierarchical are NOT modes in this system)",
            "no fictional code APIs — if you show code, show "
            "pseudocode or explicitly-marked illustrative examples",
        ],
    )
    return prose_target(
        name="prose_substrate_thesis",
        artifact_filename="thesis.md",
        seed_content="",
        brief=brief,
    )


# --- code: leetcode #3 (longest substring without repeating chars) -------


_CODE_LEETCODE_LONGEST_SUBSTRING_TARGET_SPEC = (
    "Implement `length_of_longest_substring(s: str) -> int` in "
    "solution.py.\n\n"
    "Given a string s, return the length of the longest substring "
    "without repeating characters.\n\n"
    "Examples:\n"
    "  'abcabcbb' → 3  (longest: 'abc')\n"
    "  'bbbbb'    → 1  (longest: 'b')\n"
    "  'pwwkew'   → 3  (longest: 'wke')\n"
    "  ''         → 0\n"
    "  'au'       → 2\n"
    "  ' '        → 1  (single space is one character)\n"
    "  'dvdf'     → 3  (longest: 'vdf')\n"
    "  'Aa'       → 2  (case-sensitive)\n\n"
    "The function must:\n"
    "  - Accept any string including empty, single-character, or "
    "whitespace\n"
    "  - Return 0 for empty input\n"
    "  - Be case-sensitive\n"
    "  - Treat Unicode characters as single units\n\n"
    "Recommended approach: O(n) sliding window with a dict mapping "
    "character → last-seen index. Brute force O(n²) also "
    "acceptable as long as results are correct."
)


_CODE_LEETCODE_LONGEST_SUBSTRING_SEED = (
    "def length_of_longest_substring(s: str) -> int:\n"
    "    raise NotImplementedError\n"
)


def code_leetcode_longest_substring() -> TargetConfig:
    """Real code target for the v1 study: leetcode #3.

    Sliding-window classic — well-specified, narrow scope, easy to
    eval mechanically once we wire a grader. Multiple correct
    approaches (sliding-window vs brute force) so ensemble runs have
    real differential signal between agents.

    The seed is just a function stub raising NotImplementedError so
    the artifact starts in a known-broken state — agents have to
    actually produce a working implementation, not just decorate
    a placeholder.

    Brief is built fresh per call (same rationale as
    :func:`prose_substrate_thesis`): pydantic models' list fields
    are mutable, and module-level caching would let one caller's
    in-place mutation leak to all later callers.
    """
    brief = Brief(
        target_spec=_CODE_LEETCODE_LONGEST_SUBSTRING_TARGET_SPEC,
        success_criteria=[
            "function passes all 8 example test cases above",
            "type-checks under strict mypy (no Any in the function "
            "signature)",
        ],
        constraints=[
            "single file, single function — no helper classes",
            "no third-party imports (typing is fine)",
            "no comments inside the function unless they explain a "
            "non-obvious algorithmic choice",
        ],
    )
    return code_target(
        name="code_leetcode_longest_substring",
        artifact_filename="solution.py",
        seed_content=_CODE_LEETCODE_LONGEST_SUBSTRING_SEED,
        brief=brief,
    )


# --- code: leetcode #42 (trapping rain water) ----------------------------


_CODE_LEETCODE_TRAPPING_RAIN_WATER_TARGET_SPEC = (
    "Implement `trap(height: list[int]) -> int` in solution.py.\n\n"
    "Given n non-negative integers representing an elevation map "
    "where the width of each bar is 1, compute how much water it "
    "can trap after raining.\n\n"
    "Examples:\n"
    "  [0,1,0,2,1,0,1,3,2,1,2,1] → 6\n"
    "  [4,2,0,3,2,5]             → 9\n"
    "  [3,0,2,0,4]               → 7\n"
    "  []                        → 0\n"
    "  [5]                       → 0\n"
    "  [3,3,3]                   → 0\n"
    "  [5,0,5]                   → 5\n"
    "  [1,2,3,4,5]               → 0  (monotonic increasing traps "
    "nothing)\n"
    "  [5,4,3,2,1]               → 0  (monotonic decreasing traps "
    "nothing)\n\n"
    "The function must:\n"
    "  - Accept any list[int] including empty / single-element\n"
    "  - Return 0 for empty or single-element input\n"
    "  - Handle all-zero, monotonic, flat, and pyramid terrains\n\n"
    "Recommended approaches (each is O(n) time; brute-force O(n²) "
    "is also acceptable as long as results are correct):\n"
    "  - Two-pointer: maintain left_max / right_max and walk inward\n"
    "  - Dynamic programming: prefix-max + suffix-max arrays\n"
    "  - Stack-based monotonic decreasing\n"
    "  All three are valid; pick whichever is cleanest for you."
)


_CODE_LEETCODE_TRAPPING_RAIN_WATER_SEED = (
    "def trap(height: list[int]) -> int:\n"
    "    raise NotImplementedError\n"
)


# --- code: leetcode #10 (regular expression matching) -------------------


_CODE_LEETCODE_REGEX_MATCHING_TARGET_SPEC = (
    "Implement `is_match(s: str, p: str) -> bool` in solution.py.\n\n"
    "Given an input string `s` and a pattern `p`, implement regular "
    "expression matching with support for `.` and `*`:\n\n"
    "  - `.` matches any single character\n"
    "  - `*` matches zero or more of the preceding element\n\n"
    "The matching must cover the ENTIRE input string (not partial).\n\n"
    "Examples:\n"
    "  is_match('aa', 'a')           → False  (single 'a' doesn't match 'aa')\n"
    "  is_match('aa', 'a*')          → True   (a* matches one or more 'a')\n"
    "  is_match('ab', '.*')          → True   (.* matches any sequence)\n"
    "  is_match('aab', 'c*a*b')      → True   (c* matches zero c, a* matches aa, b matches b)\n"
    "  is_match('mississippi', 'mis*is*p*.') → False\n"
    "  is_match('mississippi', 'mis*is*ip*.') → True\n"
    "  is_match('', '')              → True\n"
    "  is_match('', 'a*')            → True   (a* matches zero a's)\n"
    "  is_match('', '.*')            → True\n"
    "  is_match('a', '')             → False\n"
    "  is_match('a', 'ab*')          → True   (b* matches zero b's)\n\n"
    "The function must:\n"
    "  - Match the ENTIRE input string (e.g., is_match('ab', 'a') is False)\n"
    "  - Handle empty `s` and empty `p`\n"
    "  - Treat `*` as a quantifier on the IMMEDIATELY preceding token "
    "(`a*`, `.*`); `*` never appears as the first character of `p`\n"
    "  - Handle nested quantifiers correctly (`a*b*c*` should match "
    "many strings including empty)\n"
    "  - Handle `.` and `*` in the same pattern correctly\n\n"
    "Recommended approaches (both work):\n"
    "  - Recursion with memoization: handle '*' by trying both 'consume "
    "zero' and 'consume one and recurse' branches\n"
    "  - Bottom-up DP on a 2D table: dp[i][j] = does s[:i] match p[:j]\n\n"
    "Watch out for: greedy `.*` swallowing too much; off-by-one with "
    "trailing `*` patterns; empty-string edge cases."
)


_CODE_LEETCODE_REGEX_MATCHING_SEED = (
    "def is_match(s: str, p: str) -> bool:\n"
    "    raise NotImplementedError\n"
)


def code_leetcode_regex_matching() -> TargetConfig:
    """Real code target for the v1 study: leetcode #10 (Hard).

    Regular Expression Matching is the discrimination champion among
    Hard leetcode problems: even strong models routinely fail on
    subtle interactions between `*` and `.`, empty-string corner
    cases, and patterns like ``a*b*c*`` where multiple quantifiers
    interact. Two distinct correct approaches (recursion+memo vs
    bottom-up DP) so ensembles can show real differential signal.

    The 22 canonical test cases span LeetCode's official examples,
    classic edge cases (empty s, empty p, long quantifier chains),
    and adversarial patterns (greedy `.*` overshoot, trailing `*`
    quantifier, must-match-entire-string). Per-test granularity
    (~4.5%) gives the mechanical grader real resolution.

    Same fresh-per-call brief discipline as
    :func:`code_leetcode_longest_substring`.
    """
    brief = Brief(
        target_spec=_CODE_LEETCODE_REGEX_MATCHING_TARGET_SPEC,
        success_criteria=[
            "function passes all 22 canonical test cases",
            "type-checks under strict mypy (no Any in the function "
            "signature)",
            "handles empty-string and empty-pattern edge cases "
            "correctly",
            "matches the ENTIRE input (not partial) — ``is_match('ab', "
            "'a')`` must return False",
        ],
        constraints=[
            "single file, single function — no helper classes, but "
            "internal recursive helpers / memo dicts are fine",
            "no third-party imports (typing and functools are fine)",
        ],
    )
    return code_target(
        name="code_leetcode_regex_matching",
        artifact_filename="solution.py",
        seed_content=_CODE_LEETCODE_REGEX_MATCHING_SEED,
        brief=brief,
    )


def code_leetcode_trapping_rain_water() -> TargetConfig:
    """Real code target for the v1 study: leetcode #42 (Hard).

    Trapping Rain Water is the discrimination-friendly counterpart to
    longest-substring. Multiple valid O(n) approaches (two-pointer, DP
    with prefix/suffix max, monotonic stack) give ensembles real
    differential signal. Edge cases — empty, single element, all-zero,
    monotonic, pyramid, multiple basins — trip naive O(n²) attempts
    and partial implementations, so the mechanical grader's
    pytest-pass-rate ranges across cells rather than clustering at 1.

    Same fresh-per-call brief discipline as
    :func:`code_leetcode_longest_substring`.
    """
    brief = Brief(
        target_spec=_CODE_LEETCODE_TRAPPING_RAIN_WATER_TARGET_SPEC,
        success_criteria=[
            "function passes all 11 canonical test cases",
            "type-checks under strict mypy (no Any in the function "
            "signature)",
        ],
        constraints=[
            "single file, single function — no helper classes",
            "no third-party imports (typing is fine)",
            "no comments inside the function unless they explain a "
            "non-obvious algorithmic choice",
        ],
    )
    return code_target(
        name="code_leetcode_trapping_rain_water",
        artifact_filename="solution.py",
        seed_content=_CODE_LEETCODE_TRAPPING_RAIN_WATER_SEED,
        brief=brief,
    )


# --- code: leetcode #4 (median of two sorted arrays) --------------------


_CODE_LEETCODE_MEDIAN_TWO_SORTED_ARRAYS_TARGET_SPEC = (
    "Implement `find_median_sorted_arrays(nums1: list[int], "
    "nums2: list[int]) -> float` in solution.py.\n\n"
    "Given two sorted integer arrays of arbitrary sizes, return the "
    "median of the combined sorted array as a float.\n\n"
    "Examples:\n"
    "  ([1, 3], [2])              → 2.0\n"
    "  ([1, 2], [3, 4])           → 2.5\n"
    "  ([0, 0], [0, 0])           → 0.0\n"
    "  ([], [1])                  → 1.0\n"
    "  ([2], [])                  → 2.0\n"
    "  ([], [2, 3])               → 2.5\n"
    "  ([-5, 3, 6, 12, 15], [-12, -10, -6, -3, 4, 10]) → 3.0\n\n"
    "The function must:\n"
    "  - Accept arrays where either or both may be empty (but not "
    "both empty)\n"
    "  - Return the median as a float (single-element median is "
    "still a float)\n"
    "  - Handle negative numbers, duplicates, and large arrays "
    "(up to ~10^5 elements per array)\n"
    "  - Run in O(log(min(m, n))) time — this is graded.\n\n"
    "The performance constraint is real: the grader runs a perf "
    "test with combined input size 10^7 under a 200ms wall-clock "
    "budget timed around your function call. An O(m+n) merge in "
    "pure Python takes ~440ms on this input and will exceed the "
    "budget by ~2x. Recommended approach: binary search on partition "
    "position in the smaller array (LeetCode editorial 'Approach "
    "4').\n\n"
    "Reference: https://leetcode.com/problems/median-of-two-sorted-arrays/"
)


_CODE_LEETCODE_MEDIAN_TWO_SORTED_ARRAYS_SEED = (
    "def find_median_sorted_arrays(\n"
    "    nums1: list[int], nums2: list[int]\n"
    ") -> float:\n"
    "    raise NotImplementedError\n"
)


def code_leetcode_median_two_sorted_arrays() -> TargetConfig:
    """Real code target for the v1 study: leetcode #4 (Hard).

    Median of Two Sorted Arrays is the first v1 target whose brief's
    complexity claim is actually mechanically graded. The grader's
    ``perf`` dimension runs the agent's solution against a synthetic
    2×10^5 input under a wall-clock budget; only the O(log(min(m,n)))
    partition algorithm finishes in time. The naive O(m+n) merge
    passes the correctness tests but tanks the perf score — exactly
    the discrimination behavior we wanted from a Hard target.

    Same fresh-per-call brief discipline as
    :func:`code_leetcode_longest_substring`.
    """
    brief = Brief(
        target_spec=_CODE_LEETCODE_MEDIAN_TWO_SORTED_ARRAYS_TARGET_SPEC,
        success_criteria=[
            "function passes all 13 canonical correctness test cases",
            "type-checks under strict mypy (no Any in the function "
            "signature)",
            "completes the 10^7-element perf test within the 200ms "
            "function-call budget — only the O(log(min(m, n))) "
            "partition algorithm achieves this",
        ],
        constraints=[
            "single file, single function — no helper classes, but "
            "internal helpers (e.g., a recursive partition) are fine",
            "no imports needed — use Python 3.10+ built-in generics "
            "for type hints (``list[int]`` not ``List[int]``); do "
            "NOT ``from typing import List`` (mypy strict will "
            "accept either, but the seed and signature use the "
            "built-in spelling)",
            "do not call ``sorted()`` or ``list.sort()`` on the "
            "combined arrays — the perf budget is set such that the "
            "O((m+n) log(m+n)) sort-then-pick approach will fail it",
        ],
    )
    return code_target(
        name="code_leetcode_median_two_sorted_arrays",
        artifact_filename="solution.py",
        seed_content=_CODE_LEETCODE_MEDIAN_TWO_SORTED_ARRAYS_SEED,
        brief=brief,
    )
